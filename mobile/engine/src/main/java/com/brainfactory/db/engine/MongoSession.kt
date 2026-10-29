package com.brainfactory.db.engine

import com.mongodb.ConnectionString
import com.mongodb.MongoClientSettings
import com.mongodb.MongoCommandException
import com.mongodb.MongoCredential
import com.mongodb.MongoException
import com.mongodb.MongoSecurityException
import com.mongodb.MongoTimeoutException
import com.mongodb.ServerAddress
import com.mongodb.client.MongoClient
import com.mongodb.client.MongoClients
import com.mongodb.client.MongoCollection
import com.mongodb.client.MongoDatabase
import com.mongodb.client.model.Filters
import com.mongodb.client.model.IndexOptions
import com.mongodb.client.model.ReplaceOptions
import com.mongodb.client.model.Sorts
import com.mongodb.client.model.UpdateOptions
import com.mongodb.connection.ClusterConnectionMode
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern
import kotlin.concurrent.thread
import org.bson.Document
import org.bson.conversions.Bson

/**
 * MongoDB 4.0+ and Atlas, through the Java sync driver. `mongodb+srv://` works (its DNS lookups go over HTTPS);
 * an SSH tunnel reaches one server directly. Collections are browsed like tables, with `_id` as the key.
 */
class MongoSession(override val profile: ConnectionProfile, private val env: EngineEnv) : DbSession {

    override val capabilities = Capabilities(realtime = "Change streams")

    private var tunnel: SshTunnel? = null
    private val client: MongoClient
    private val defaultDatabase: String?

    override var currentDatabase: String? = null
        private set

    init {
        val settings = MongoClientSettings.builder().dnsClient(DohDnsClient)
        var uriDatabase: String? = null
        if (profile.usesUri) {
            val uri = ConnectionString(profile.host.trim())
            uriDatabase = uri.database
            settings.applyConnectionString(uri)
            profile.ssh?.let { ssh ->
                if (profile.host.startsWith("mongodb+srv://")) throw DbException("An SSH tunnel reaches one server; use a mongodb:// address with a single host instead of mongodb+srv://.")
                val hosts = uri.hosts
                if (hosts.size != 1) throw DbException("An SSH tunnel reaches one server, but the connection string names ${hosts.size}.")
                val target = ServerAddress(hosts.first())
                val t = SshTunnel.open(ssh, target.host, target.port, env.knownHosts).also { tunnel = it }
                settings.applyToClusterSettings { it.hosts(listOf(ServerAddress("127.0.0.1", t.localPort))).mode(ClusterConnectionMode.SINGLE).requiredReplicaSetName(null) }
            }
        } else {
            var host = profile.host.ifBlank { "127.0.0.1" }
            var port = profile.port
            profile.ssh?.let { ssh ->
                val t = SshTunnel.open(ssh, host, port, env.knownHosts).also { tunnel = it }
                host = "127.0.0.1"
                port = t.localPort
            }
            settings.applyToClusterSettings { it.hosts(listOf(ServerAddress(host, port))).mode(ClusterConnectionMode.SINGLE) }
            if (profile.user.isNotBlank()) {
                settings.credential(MongoCredential.createCredential(profile.user, "admin", profile.password.toCharArray()))
            }
            settings.applyToSslSettings { it.enabled(profile.sslMode == SslMode.REQUIRED || profile.sslMode == SslMode.VERIFY_CA).invalidHostNameAllowed(profile.sslMode != SslMode.VERIFY_CA) }
        }
        settings.applyToClusterSettings { it.serverSelectionTimeout(15, TimeUnit.SECONDS) }
        settings.applyToSocketSettings { it.connectTimeout(15, TimeUnit.SECONDS) }
        settings.applicationName("Brain DB")
        client = MongoClients.create(settings.build())
        try {
            client.getDatabase("admin").runCommand(Document("ping", 1))
        } catch (e: Exception) {
            close()
            throw DbException(friendly(e), e)
        }
        defaultDatabase = profile.database.takeIf { it.isNotBlank() } ?: uriDatabase
        currentDatabase = defaultDatabase ?: runCatching { databases().firstOrNull { it !in SYSTEM } }.getOrNull() ?: "test"
    }

    override fun close() {
        runCatching { client.close() }
        tunnel?.close()
    }

    private inline fun <T> wrap(block: () -> T): T = try {
        block()
    } catch (e: DbException) {
        throw e
    } catch (e: Exception) {
        throw DbException(friendly(e), e)
    }

    private fun friendly(e: Throwable): String = when (e) {
        is MongoSecurityException -> "Sign-in refused: check the user, password and authentication database. (${e.cause?.message ?: e.message})"
        is MongoTimeoutException -> "No MongoDB server answered in time. Check the address, network and TLS setting." +
            (Regex("exception=\\{([^}]*)\\}").find(e.message.orEmpty())?.groupValues?.get(1)?.let { " ($it)" } ?: "")
        is MongoCommandException -> e.errorMessage.ifBlank { e.message.orEmpty() }
        is MongoException -> e.message.orEmpty()
        is IllegalArgumentException -> "The connection string isn't valid: ${e.message}"
        else -> e.message ?: e.javaClass.simpleName
    }

    private fun db(name: String? = null): MongoDatabase = client.getDatabase(name ?: currentDatabase ?: "test")

    private fun collection(table: TableRef): MongoCollection<Document> = db(table.database).getCollection(table.name)

    override fun ping() {
        wrap { client.getDatabase("admin").runCommand(Document("ping", 1)) }
    }

    override fun databases(): List<String> = wrap {
        try {
            client.listDatabaseNames().toList()
        } catch (e: MongoCommandException) {
            // A user allowed into one database may not list them all.
            listOfNotNull(defaultDatabase ?: currentDatabase)
        }
    }

    override fun useDatabase(name: String) {
        currentDatabase = name
    }

    override fun split(text: String) = splitShell(text)

    override fun objects(): List<DbObject> = wrap {
        db().listCollections().map { info ->
            val type = info.getString("type") ?: "collection"
            DbObject(info.getString("name"), if (type == "view") ObjectKind.VIEW else ObjectKind.COLLECTION, detail = if (type == "timeseries") "time series" else null)
        }.toList().filterNot { it.name.startsWith("system.") }.sortedBy { it.name }
    }

    private fun filterOf(request: BrowseRequest): Bson {
        val parts = mutableListOf<Bson>()
        for (f in request.filters) {
            if (f.column.isBlank()) continue
            val v = parseValue(f.value)
            parts += when (f.op) {
                FilterOp.EQ -> Filters.eq(f.column, v)
                FilterOp.NE -> Filters.ne(f.column, v)
                FilterOp.GT -> Filters.gt(f.column, v)
                FilterOp.GE -> Filters.gte(f.column, v)
                FilterOp.LT -> Filters.lt(f.column, v)
                FilterOp.LE -> Filters.lte(f.column, v)
                FilterOp.CONTAINS -> Filters.regex(f.column, Pattern.quote(f.value), "i")
                FilterOp.NOT_CONTAINS -> Filters.not(Filters.regex(f.column, Pattern.quote(f.value), "i"))
                FilterOp.STARTS_WITH -> Filters.regex(f.column, "^" + Pattern.quote(f.value), "i")
                FilterOp.IS_NULL -> Filters.eq(f.column, null)
                FilterOp.IS_NOT_NULL -> Filters.ne(f.column, null)
            }
        }
        if (request.rawFilter.isNotBlank()) parts += parseDocument(request.rawFilter, "filter")
        return when (parts.size) {
            0 -> Document()
            1 -> parts.first()
            else -> Filters.and(parts)
        }
    }

    private fun describe(table: TableRef, request: BrowseRequest, filter: Bson): String {
        val f = filter.toBsonDocument().toJson(SHELL_JSON)
        val sort = if (request.sort.isEmpty()) "" else ".sort(" + Document(request.sort.associate { it.column to (if (it.descending) -1 else 1) }).toJson() + ")"
        return "db.${table.name}.find($f)$sort" + (if (request.offset > 0) ".skip(${request.offset})" else "") + ".limit(${request.limit})"
    }

    override fun browse(table: TableRef, request: BrowseRequest): BrowsePage = wrap {
        val filter = filterOf(request)
        val (docs, ms) = timed {
            var find = collection(table).find(filter).skip(request.offset.toInt()).limit(request.limit)
            // _id order unless sorted otherwise, so pages are stable (a view may have no _id; it keeps its own order).
            val sort = request.sort.ifEmpty { if (table.kind == ObjectKind.COLLECTION) listOf(SortSpec("_id")) else emptyList() }
            if (sort.isNotEmpty()) find = find.sort(Sorts.orderBy(sort.map { if (it.descending) Sorts.descending(it.column) else Sorts.ascending(it.column) }))
            find.into(mutableListOf())
        }
        val result = documentsTable(docs)
        val keys = if (table.kind == ObjectKind.COLLECTION && result.columns.any { it.name == "_id" }) listOf("_id") else emptyList()
        BrowsePage(result, keys, describe(table, request, filter), ms, documents = docs.map { it.toJson(SHELL_JSON_INDENT) })
    }

    override fun count(table: TableRef, request: BrowseRequest): Long? = wrap {
        if (request.filters.isEmpty() && request.rawFilter.isBlank()) collection(table).estimatedDocumentCount()
        else collection(table).countDocuments(filterOf(request))
    }

    private fun idFilter(key: Map<String, Any?>): Bson {
        if (!key.containsKey("_id")) throw DbException("These documents have no _id, so they can't be told apart to edit.")
        return Filters.eq("_id", rawOf(key["_id"]))
    }

    private fun idText(key: Map<String, Any?>) = bsonJson(rawOf(key["_id"]))

    override fun updateCell(table: TableRef, key: Map<String, Any?>, column: String, value: CellInput): String = wrap {
        profile.requireWritable()
        if (column == "_id") throw DbException("A document's _id can't be changed; duplicate it with a new _id instead.")
        val update = when (value) {
            CellInput.Null -> Document("\$set", Document(column, null))
            CellInput.Default -> Document("\$unset", Document(column, ""))
            is CellInput.Text -> Document("\$set", Document(column, parseValue(value.value)))
        }
        val result = collection(table).updateOne(idFilter(key), update)
        if (result.matchedCount == 0L) throw DbException("The document wasn't found: it may have been deleted. Refresh and try again.")
        "db.${table.name}.updateOne({_id: ${idText(key)}}, ${update.toJson(SHELL_JSON)})"
    }

    /** Replaces a whole document with [json] (its `_id` stays). */
    fun replaceDocument(table: TableRef, key: Map<String, Any?>, json: String): String = wrap {
        profile.requireWritable()
        val doc = parseDocument(json)
        val id = rawOf(key["_id"])
        if (doc.containsKey("_id") && bsonJson(doc["_id"]) != bsonJson(id)) throw DbException("A document's _id can't be changed; remove _id or keep it as it was.")
        doc["_id"] = id
        val result = collection(table).replaceOne(idFilter(key), doc, ReplaceOptions())
        if (result.matchedCount == 0L) throw DbException("The document wasn't found: it may have been deleted. Refresh and try again.")
        "db.${table.name}.replaceOne({_id: ${idText(key)}}, …)"
    }

    /** Inserts [json] as a new document. */
    fun insertDocument(table: TableRef, json: String): String = wrap {
        profile.requireWritable()
        val doc = parseDocument(json)
        collection(table).insertOne(doc)
        "db.${table.name}.insertOne(${doc.toJson(SHELL_JSON)})"
    }

    override fun insertRow(table: TableRef, values: Map<String, CellInput>): String {
        val doc = Document()
        values.forEach { (k, v) ->
            when (v) {
                CellInput.Null -> doc[k] = null
                is CellInput.Text -> if (k != "_id" || v.value.isNotBlank()) doc[k] = parseValue(v.value)
                CellInput.Default -> Unit
            }
        }
        return insertDocument(table, doc.toJson(SHELL_JSON))
    }

    override fun deleteRows(table: TableRef, keys: List<Map<String, Any?>>): String = wrap {
        profile.requireWritable()
        val ids = keys.map { rawOf(it["_id"]) }
        collection(table).deleteMany(Filters.`in`("_id", ids))
        "db.${table.name}.deleteMany({_id: {\$in: [" + ids.joinToString(", ") { bsonJson(it) } + "]}})"
    }

    override fun structure(table: TableRef): TableStructure = wrap {
        val coll = collection(table)
        val sample = coll.find().limit(200).into(mutableListOf())
        val fields = LinkedHashMap<String, MutableMap<String, Int>>()
        for (doc in sample) for ((k, v) in doc) fields.getOrPut(k) { mutableMapOf() }.merge(bsonTypeName(v), 1, Int::plus)
        val columns = fields.map { (name, types) ->
            val seen = types.values.sum()
            ColumnInfo(
                name,
                types.entries.sortedByDescending { it.value }.joinToString(" | ") { it.key },
                nullable = "null" in types || seen < sample.size,
                key = if (name == "_id") "PRI" else "",
                extra = if (sample.isEmpty()) "" else "in ${seen * 100 / sample.size}% of ${sample.size} sampled",
            )
        }
        val indexes = if (table.kind == ObjectKind.COLLECTION) coll.listIndexes().map { ix ->
            val keys = ix.get("key", Document::class.java) ?: Document()
            IndexInfo(ix.getString("name"), keys.map { (k, v) -> "$k: $v" }, ix.getBoolean("unique", false), primary = ix.getString("name") == "_id_", definition = ix.toJson(SHELL_JSON))
        }.toList() else emptyList()
        val info = runCatching {
            val stats = db(table.database).runCommand(Document("collStats", table.name))
            listOfNotNull(
                stats["count"]?.let { "Documents" to it.toString() },
                (stats["size"] as? Number)?.let { "Data size" to formatBytes(it.toLong()) },
                (stats["storageSize"] as? Number)?.let { "Storage size" to formatBytes(it.toLong()) },
                (stats["avgObjSize"] as? Number)?.let { "Average document" to formatBytes(it.toLong()) },
                (stats["totalIndexSize"] as? Number)?.let { "Index size" to formatBytes(it.toLong()) },
                stats["nindexes"]?.let { "Indexes" to it.toString() },
                (stats["capped"] as? Boolean)?.takeIf { it }?.let { "Capped" to "yes" },
            )
        }.getOrElse { listOf("Documents (estimate)" to coll.estimatedDocumentCount().toString()) }
        val options = runCatching {
            db(table.database).listCollections().filter(Filters.eq("name", table.name)).first()?.toJson(SHELL_JSON_INDENT)
        }.getOrNull()
        TableStructure(columns, indexes, emptyList(), options, info)
    }

    override fun execute(text: String, maxRows: Int): List<StatementResult> {
        val out = mutableListOf<StatementResult>()
        for (line in split(text)) {
            val start = System.nanoTime()
            val result = try {
                run(parseShell(line), maxRows)
            } catch (e: Exception) {
                StatementResult(line, error = if (e is DbException) e.message.orEmpty() else friendly(e))
            }
            out += result.copy(millis = (System.nanoTime() - start) / 1_000_000)
            if (!result.ok) break
        }
        return out
    }

    private fun arg(args: List<String>, i: Int): Document = args.getOrNull(i)?.let { parseDocument(it) } ?: Document()

    private fun requireReading(name: String) {
        if (profile.readOnly && name !in MONGO_READING) throw DbException("This connection is read-only, so $name() doesn't run.")
    }

    private fun one(statement: String, doc: Document) = StatementResult(statement, table = documentsTable(listOf(doc)))

    private fun run(command: ShellCommand, maxRows: Int): StatementResult = wrap {
        when (command) {
            is ShellCommand.Show -> when (command.what) {
                "dbs", "databases" -> StatementResult(command.text, table = ResultTable(listOf(ColumnMeta("name")), databases().map { listOf(it) }))
                "collections", "tables" -> StatementResult(command.text, table = ResultTable(listOf(ColumnMeta("name"), ColumnMeta("type")), objects().map { listOf(it.name, if (it.kind == ObjectKind.VIEW) "view" else "collection") }))
                else -> throw DbException("show ${command.what} isn't supported; try show dbs or show collections.")
            }
            is ShellCommand.Use -> {
                currentDatabase = command.database
                StatementResult(command.text, message = "switched to db ${command.database}")
            }
            is ShellCommand.OnDatabase -> runOnDatabase(command)
            is ShellCommand.OnCollection -> runOnCollection(command, maxRows)
        }
    }

    private fun admin(command: Document): Document = client.getDatabase("admin").runCommand(command)

    private fun runOnDatabase(command: ShellCommand.OnDatabase): StatementResult {
        val call = command.call
        requireReading(call.name)
        val database = db(command.database)
        return when (call.name) {
            "runCommand", "adminCommand" -> {
                if (profile.readOnly) throw DbException("This connection is read-only, so commands don't run.")
                val doc = arg(call.args, 0)
                one(command.text, (if (call.name == "adminCommand") client.getDatabase("admin") else database).runCommand(doc))
            }
            "getCollectionNames" -> StatementResult(command.text, table = ResultTable(listOf(ColumnMeta("name")), database.listCollectionNames().toList().sorted().map { listOf(it) }))
            "getName" -> StatementResult(command.text, message = database.name)
            "stats" -> one(command.text, database.runCommand(Document("dbStats", 1)))
            "createCollection" -> {
                database.createCollection(call.args.firstOrNull()?.trim('"', '\'') ?: throw DbException("createCollection needs a name."))
                StatementResult(command.text, message = "Collection created.")
            }
            "dropDatabase" -> {
                database.drop()
                StatementResult(command.text, message = "Database ${database.name} dropped.")
            }
            "currentOp" -> one(command.text, admin(Document("currentOp", 1)))
            "serverStatus" -> one(command.text, admin(Document("serverStatus", 1)))
            "hostInfo" -> one(command.text, admin(Document("hostInfo", 1)))
            "buildInfo" -> one(command.text, admin(Document("buildInfo", 1)))
            "version" -> StatementResult(command.text, message = admin(Document("buildInfo", 1)).getString("version"))
            "hello", "isMaster" -> one(command.text, admin(Document("hello", 1)))
            "getCollectionInfos" -> StatementResult(command.text, table = documentsTable(database.listCollections().into(mutableListOf())))
            "getUsers" -> StatementResult(command.text, table = documentsTable((database.runCommand(Document("usersInfo", 1))["users"] as? List<*>).orEmpty().filterIsInstance<Document>()))
            "rs.status" -> {
                val status = admin(Document("replSetGetStatus", 1))
                StatementResult(command.text, table = documentsTable((status["members"] as? List<*>).orEmpty().filterIsInstance<Document>()), message = "Replica set ${status.getString("set")}")
            }
            "rs.conf" -> one(command.text, admin(Document("replSetGetConfig", 1)).get("config", Document::class.java) ?: Document())
            else -> throw DbException("db.${call.name}() isn't supported here.")
        }
    }

    private fun runOnCollection(command: ShellCommand.OnCollection, maxRows: Int): StatementResult {
        val coll = db(command.database).getCollection(command.collection)
        val call = command.call
        val args = call.args
        requireReading(call.name)
        val t = command.text
        return when (call.name) {
            "find" -> {
                var find = coll.find(arg(args, 0))
                args.getOrNull(1)?.let { find = find.projection(parseDocument(it)) }
                var limit = maxRows
                var userLimit = false
                var countOnly = false
                var explain = false
                for (c in command.chain) when (c.name) {
                    "sort" -> find = find.sort(arg(c.args, 0))
                    "limit" -> c.args.firstOrNull()?.trim()?.toIntOrNull()?.takeIf { it in 1..maxRows }?.let { limit = it; userLimit = true }
                    "skip" -> find = find.skip(c.args.firstOrNull()?.trim()?.toIntOrNull() ?: 0)
                    "projection", "project" -> find = find.projection(arg(c.args, 0))
                    "count", "size", "itcount" -> countOnly = true
                    "explain" -> explain = true
                    "pretty", "toArray" -> Unit
                    else -> throw DbException(".${c.name}() isn't supported after find().")
                }
                if (countOnly) return StatementResult(t, message = coll.countDocuments(arg(args, 0)).toString() + " documents")
                if (explain) return one(t, find.limit(limit).explain())
                val docs = find.limit(if (userLimit) limit else limit + 1).into(mutableListOf())
                StatementResult(t, table = documentsTable(docs.take(limit), truncated = !userLimit && docs.size > limit))
            }
            "findOne" -> {
                var find = coll.find(arg(args, 0)).limit(1)
                args.getOrNull(1)?.let { find = find.projection(parseDocument(it)) }
                StatementResult(t, table = documentsTable(listOfNotNull(find.first())))
            }
            "countDocuments", "count" -> StatementResult(t, message = coll.countDocuments(arg(args, 0)).toString() + " documents")
            "estimatedDocumentCount" -> StatementResult(t, message = coll.estimatedDocumentCount().toString() + " documents")
            "distinct" -> {
                val field = args.firstOrNull()?.trim()?.trim('"', '\'') ?: throw DbException("distinct needs a field name.")
                // Read as BsonValue (the driver has no codec for Object) and turned into the values the grid shows.
                val values = coll.distinct(field, arg(args, 1), org.bson.BsonValue::class.java).take(maxRows).map { fromBson(it) }
                StatementResult(t, table = ResultTable(listOf(ColumnMeta(field)), values.map { listOf(cellOf(it)) }))
            }
            "aggregate" -> {
                val pipelineText = args.firstOrNull() ?: "[]"
                val stages = (parseValue(pipelineText) as? List<*>)?.map { it as? Document ?: throw DbException("Each pipeline stage must be a document.") }
                    ?: throw DbException("aggregate needs a pipeline: an array of stages, as in aggregate([{ \$match: { … } }])")
                if (profile.readOnly && stages.any { s -> s.keys.any { it == "\$out" || it == "\$merge" } }) throw DbException("This connection is read-only, so \$out and \$merge don't run.")
                if (command.chain.any { it.name == "explain" }) return one(t, coll.aggregate(stages).explain())
                val docs = coll.aggregate(stages).into(mutableListOf())
                StatementResult(t, table = documentsTable(docs.take(maxRows), truncated = docs.size > maxRows))
            }
            "insertOne" -> {
                val doc = arg(args, 0)
                coll.insertOne(doc)
                StatementResult(t, affected = 1, message = "Inserted _id " + bsonJson(doc["_id"]))
            }
            "insertMany" -> {
                val docs = (parseValue(args.firstOrNull() ?: "[]") as? List<*>)?.map { it as? Document ?: throw DbException("insertMany needs an array of documents.") }
                    ?: throw DbException("insertMany needs an array of documents.")
                if (docs.isEmpty()) throw DbException("insertMany needs at least one document.")
                coll.insertMany(docs)
                StatementResult(t, affected = docs.size.toLong(), message = "Inserted ${docs.size} documents")
            }
            "updateOne", "updateMany" -> {
                val filter = arg(args, 0)
                val updateValue = parseValue(args.getOrNull(1) ?: throw DbException("${call.name} needs a filter and an update."))
                val options = UpdateOptions().upsert(arg(args, 2).getBoolean("upsert", false))
                val result = when (updateValue) {
                    is Document -> if (call.name == "updateOne") coll.updateOne(filter, updateValue, options) else coll.updateMany(filter, updateValue, options)
                    is List<*> -> {
                        val pipeline = updateValue.map { it as Document }
                        if (call.name == "updateOne") coll.updateOne(filter, pipeline, options) else coll.updateMany(filter, pipeline, options)
                    }
                    else -> throw DbException("The update must be a document like { \$set: { … } } or a pipeline.")
                }
                StatementResult(t, affected = result.modifiedCount, message = "Matched ${result.matchedCount}, modified ${result.modifiedCount}" + (result.upsertedId?.let { ", upserted ${bsonJson(it)}" } ?: ""))
            }
            "replaceOne" -> {
                val result = coll.replaceOne(arg(args, 0), arg(args, 1), ReplaceOptions().upsert(arg(args, 2).getBoolean("upsert", false)))
                StatementResult(t, affected = result.modifiedCount, message = "Matched ${result.matchedCount}, modified ${result.modifiedCount}")
            }
            "findOneAndUpdate" -> {
                val update = parseValue(args.getOrNull(1) ?: throw DbException("findOneAndUpdate needs a filter and an update."))
                val opts = arg(args, 2)
                val options = com.mongodb.client.model.FindOneAndUpdateOptions().upsert(opts.getBoolean("upsert", false))
                    .returnDocument(if (opts["returnDocument"] == "after" || opts.getBoolean("returnNewDocument", false)) com.mongodb.client.model.ReturnDocument.AFTER else com.mongodb.client.model.ReturnDocument.BEFORE)
                val doc = when (update) {
                    is Document -> coll.findOneAndUpdate(arg(args, 0), update, options)
                    is List<*> -> coll.findOneAndUpdate(arg(args, 0), update.map { it as Document }, options)
                    else -> throw DbException("The update must be a document like { \$set: { … } } or a pipeline.")
                }
                StatementResult(t, table = documentsTable(listOfNotNull(doc)), message = if (doc == null) "No document matched." else null)
            }
            "findOneAndReplace" -> {
                val doc = coll.findOneAndReplace(arg(args, 0), arg(args, 1))
                StatementResult(t, table = documentsTable(listOfNotNull(doc)), message = if (doc == null) "No document matched." else null)
            }
            "findOneAndDelete" -> {
                val doc = coll.findOneAndDelete(arg(args, 0))
                StatementResult(t, table = documentsTable(listOfNotNull(doc)), affected = if (doc == null) 0 else 1)
            }
            "deleteOne" -> StatementResult(t, affected = coll.deleteOne(arg(args, 0)).deletedCount)
            "deleteMany", "remove" -> StatementResult(t, affected = coll.deleteMany(arg(args, 0)).deletedCount)
            "drop" -> {
                coll.drop()
                StatementResult(t, message = "Collection ${command.collection} dropped.")
            }
            "getIndexes" -> StatementResult(t, table = documentsTable(coll.listIndexes().into(mutableListOf())))
            "createIndex" -> {
                val opts = arg(args, 1)
                val options = IndexOptions().unique(opts.getBoolean("unique", false)).sparse(opts.getBoolean("sparse", false))
                opts.getString("name")?.let { options.name(it) }
                (opts["expireAfterSeconds"] as? Number)?.let { options.expireAfter(it.toLong(), TimeUnit.SECONDS) }
                StatementResult(t, message = "Created index " + coll.createIndex(arg(args, 0), options))
            }
            "dropIndex" -> {
                val a = args.firstOrNull()?.trim() ?: throw DbException("dropIndex needs the index name or keys.")
                if (a.startsWith("{")) coll.dropIndex(parseDocument(a)) else coll.dropIndex(a.trim('"', '\''))
                StatementResult(t, message = "Index dropped.")
            }
            "dropIndexes" -> {
                coll.dropIndexes()
                StatementResult(t, message = "Indexes dropped.")
            }
            "stats" -> one(t, db(command.database).runCommand(Document("collStats", command.collection)))
            "renameCollection" -> {
                val target = args.firstOrNull()?.trim()?.trim('"', '\'') ?: throw DbException("renameCollection needs the new name.")
                coll.renameCollection(com.mongodb.MongoNamespace(coll.namespace.databaseName, target))
                StatementResult(t, message = "Renamed to $target.")
            }
            else -> throw DbException("${call.name}() isn't supported. Supported: find, findOne, countDocuments, distinct, aggregate, insertOne, insertMany, updateOne, updateMany, replaceOne, findOneAndUpdate, findOneAndReplace, findOneAndDelete, deleteOne, deleteMany, drop, getIndexes, createIndex, dropIndex, stats, renameCollection.")
        }
    }

    override fun processList(): ResultTable = wrap {
        val ops = (client.getDatabase("admin").runCommand(Document("currentOp", 1))["inprog"] as? List<*>).orEmpty().filterIsInstance<Document>()
        val columns = listOf("opid", "active", "op", "ns", "secs_running", "client", "desc", "command").map { ColumnMeta(it) }
        ResultTable(columns, ops.map { op ->
            listOf(cellOf(op["opid"]), cellOf(op["active"]), cellOf(op["op"]), cellOf(op["ns"]), cellOf(op["secs_running"]), cellOf(op["client"] ?: op["client_s"]), cellOf(op["desc"]), cellOf(op["command"]))
        })
    }

    override fun processKill(id: Any?) {
        wrap { client.getDatabase("admin").runCommand(Document("killOp", 1).append("op", rawOf(id))) }
    }

    override fun openRealtime(): RealtimeChannel = ChangeStreams()

    /** Change streams (replica sets and Atlas only): one watcher per collection, or `*` for the whole database. */
    private inner class ChangeStreams : RealtimeChannel {
        override val targetLabel = "Collection (* for all)"
        override val canPublish = false
        private val watchers = mutableMapOf<String, com.mongodb.client.MongoChangeStreamCursor<*>>()
        private var onMessage: ((RealtimeMessage) -> Unit)? = null
        private var onError: ((String) -> Unit)? = null
        private val database = currentDatabase

        override fun subscribe(target: String) {
            if (watchers.containsKey(target)) return
            val cursor = wrap {
                if (target == "*") db(database).watch().cursor() else db(database).getCollection(target).watch().cursor()
            }
            synchronized(watchers) { watchers[target] = cursor }
            thread(name = "mongo-watch-$target", isDaemon = true) {
                try {
                    while (true) {
                        val change = cursor.tryNext() ?: continue
                        val ns = change.namespace?.collectionName ?: target
                        val body = Document("operationType", change.operationTypeString)
                        change.documentKey?.let { body["documentKey"] = Document.parse(it.toJson()) }
                        change.fullDocument?.let { body["fullDocument"] = it }
                        change.updateDescription?.let { u -> body["updatedFields"] = u.updatedFields?.let { Document.parse(it.toJson()) }; body["removedFields"] = u.removedFields }
                        onMessage?.invoke(RealtimeMessage(ns, body.toJson(SHELL_JSON_INDENT)))
                    }
                } catch (e: Exception) {
                    if (synchronized(watchers) { watchers.containsKey(target) }) onError?.invoke(friendly(e))
                }
            }
        }

        override fun unsubscribe(target: String) {
            synchronized(watchers) { watchers.remove(target) }?.let { runCatching { it.close() } }
        }

        override fun publish(target: String, payload: String) = throw DbException("Change streams can't be published to; insert or update a document instead.")

        override fun start(onMessage: (RealtimeMessage) -> Unit, onError: (String) -> Unit) {
            this.onMessage = onMessage
            this.onError = onError
        }

        override fun close() {
            val all = synchronized(watchers) { watchers.values.toList().also { watchers.clear() } }
            all.forEach { runCatching { it.close() } }
        }
    }

    companion object {
        private val SYSTEM = setOf("admin", "local", "config")
    }
}
