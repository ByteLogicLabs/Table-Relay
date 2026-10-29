package com.brainfactory.db.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.brainfactory.db.engine.QueryLanguage
import com.brainfactory.db.engine.SQL_KEYWORDS

/** Colours keywords, strings, numbers and comments, per query language. */
class SyntaxHighlight(private val language: QueryLanguage, private val colors: BdColors) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText = TransformedText(highlight(text.text), OffsetMapping.Identity)

    private fun highlight(s: String): AnnotatedString = buildAnnotatedString {
        append(s)
        if (s.length > 60_000) return@buildAnnotatedString
        var i = 0
        val n = s.length
        /** Whether only blanks stand between the line's start and [at]. */
        fun lineStart(at: Int): Boolean {
            var k = at - 1
            while (k >= 0 && s[k] != '\n') { if (!s[k].isWhitespace()) return false; k-- }
            return true
        }
        while (i < n) {
            val c = s[i]
            when {
                // Comments: -- and # (SQL), // (Mongo), # at a line's start (Redis)
                (language == QueryLanguage.SQL && c == '-' && i + 1 < n && s[i + 1] == '-') ||
                    (language == QueryLanguage.MONGO && c == '/' && i + 1 < n && s[i + 1] == '/') ||
                    (c == '#' && (language == QueryLanguage.SQL || lineStart(i))) -> {
                    val end = s.indexOf('\n', i).let { if (it < 0) n else it }
                    addStyle(SpanStyle(color = colors.comment), i, end)
                    i = end
                }
                c == '/' && i + 1 < n && s[i + 1] == '*' && language != QueryLanguage.REDIS -> {
                    val end = s.indexOf("*/", i + 2).let { if (it < 0) n else it + 2 }
                    addStyle(SpanStyle(color = colors.comment), i, end)
                    i = end
                }
                c == '\'' || c == '"' || c == '`' -> {
                    var j = i + 1
                    while (j < n && s[j] != c) { if (s[j] == '\\') j++; j++ }
                    val end = minOf(n, j + 1)
                    addStyle(SpanStyle(color = if (c == '`') colors.text else colors.string), i, end)
                    i = end
                }
                c.isDigit() && (i == 0 || !s[i - 1].isLetterOrDigit() && s[i - 1] != '_') -> {
                    var j = i
                    while (j < n && (s[j].isLetterOrDigit() || s[j] == '.')) j++
                    addStyle(SpanStyle(color = colors.number), i, j)
                    i = j
                }
                c.isLetter() || c == '_' || c == '$' -> {
                    var j = i
                    while (j < n && (s[j].isLetterOrDigit() || s[j] == '_' || s[j] == '$' || (language == QueryLanguage.REDIS && s[j] == '.'))) j++
                    val word = s.substring(i, j)
                    val keyword = when (language) {
                        QueryLanguage.SQL -> word.uppercase() in SQL_KEYWORD_SET
                        QueryLanguage.MONGO -> word in MONGO_WORDS || word.startsWith("$")
                        QueryLanguage.REDIS -> lineStart(i) && word.uppercase() in REDIS_COMMANDS
                    }
                    if (keyword) addStyle(SpanStyle(color = colors.keyword, fontWeight = FontWeight.Medium), i, j)
                    i = j
                }
                else -> i++
            }
        }
    }

    companion object {
        private val SQL_KEYWORD_SET = SQL_KEYWORDS.toSet()
    }
}

val MONGO_WORDS = setOf(
    "db", "find", "findOne", "aggregate", "insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne",
    "deleteMany", "countDocuments", "estimatedDocumentCount", "distinct", "sort", "limit", "skip", "projection", "drop",
    "createIndex", "dropIndex", "getIndexes", "runCommand", "adminCommand", "getCollection", "getSiblingDB", "show", "use",
    "stats", "ObjectId", "ISODate", "NumberLong", "NumberInt", "NumberDecimal", "true", "false", "null", "count",
    "createCollection", "dropDatabase", "getCollectionNames", "renameCollection",
)

val REDIS_COMMANDS = setOf(
    "GET", "SET", "DEL", "EXISTS", "EXPIRE", "TTL", "PTTL", "PERSIST", "KEYS", "SCAN", "TYPE", "RENAME", "INCR", "DECR",
    "INCRBY", "APPEND", "MGET", "MSET", "SETEX", "SETNX", "GETSET", "STRLEN", "HGET", "HSET", "HDEL", "HGETALL", "HKEYS",
    "HVALS", "HLEN", "HINCRBY", "HEXISTS", "HSCAN", "LPUSH", "RPUSH", "LPOP", "RPOP", "LRANGE", "LLEN", "LINDEX", "LSET",
    "LREM", "LTRIM", "SADD", "SREM", "SMEMBERS", "SCARD", "SISMEMBER", "SSCAN", "SINTER", "SUNION", "ZADD", "ZREM",
    "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZCARD", "ZSCORE", "ZINCRBY", "ZRANK", "ZSCAN", "XADD", "XRANGE", "XLEN",
    "XDEL", "XREAD", "PUBLISH", "INFO", "PING", "DBSIZE", "SELECT", "FLUSHDB", "FLUSHALL", "CONFIG", "CLIENT", "MEMORY",
    "OBJECT", "TIME", "ECHO", "SLOWLOG", "JSON.GET", "JSON.SET", "MULTI", "EXEC", "DISCARD", "EVAL", "UNLINK", "COPY",
)

/** The word being typed before the cursor, for completion. */
private fun currentWord(value: TextFieldValue): Pair<Int, String> {
    val cursor = value.selection.start
    var start = cursor
    while (start > 0 && (value.text[start - 1].isLetterOrDigit() || value.text[start - 1] == '_' || value.text[start - 1] == '$')) start--
    return start to value.text.substring(start, cursor)
}

/** Completions for the word at the cursor: keywords or commands, then the workspace's tables or collections. */
fun completions(value: TextFieldValue, language: QueryLanguage, names: List<String>): List<String> {
    val (_, word) = currentWord(value)
    if (word.length < 1) return emptyList()
    val pool = when (language) {
        QueryLanguage.SQL -> names + SQL_KEYWORDS
        QueryLanguage.MONGO -> names + MONGO_WORDS
        QueryLanguage.REDIS -> REDIS_COMMANDS.toList()
    }
    return pool.asSequence().filter { it.startsWith(word, ignoreCase = true) && !it.equals(word, ignoreCase = true) }.distinct().take(12).toList()
}

fun applyCompletion(value: TextFieldValue, completion: String, language: QueryLanguage): TextFieldValue {
    val (start, word) = currentWord(value)
    val keepCase = language == QueryLanguage.SQL && word.isNotEmpty() && word.all { it.isLowerCase() || !it.isLetter() } && completion.uppercase() == completion
    val inserted = if (keepCase) completion.lowercase() else completion
    val end = value.selection.start
    val text = value.text.substring(0, start) + inserted + value.text.substring(end)
    return TextFieldValue(text, TextRange(start + inserted.length))
}

fun insertAtCursor(value: TextFieldValue, s: String): TextFieldValue {
    val text = value.text.substring(0, value.selection.min) + s + value.text.substring(value.selection.max)
    val pos = value.selection.min + s.length
    // A pair of brackets or quotes leaves the cursor between them.
    val back = if (s.length == 2 && s[0] in "([{'\"`" ) 1 else 0
    return TextFieldValue(text, TextRange(pos - back))
}

/**
 * The query editor: monospaced and highlighted, lines wrapped to the screen's width (a phone is too narrow to
 * scroll sideways through SQL), and the whole pane is the text field, so a tap anywhere puts the cursor in it.
 */
@Composable
fun QueryEditorField(
    value: TextFieldValue,
    onChange: (TextFieldValue) -> Unit,
    language: QueryLanguage,
    fontSize: Int,
    modifier: Modifier = Modifier,
    focusRequester: FocusRequester = remember { FocusRequester() },
    placeholder: String = "",
) {
    val t = bd
    val highlight = remember(language, t) { SyntaxHighlight(language, t) }
    BoxWithConstraints(modifier.background(t.background)) {
        val viewport = maxHeight
        Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            if (value.text.isEmpty()) Text(placeholder, style = monoStyle(fontSize), color = t.textFaint, modifier = Modifier.padding(10.dp))
            BasicTextField(
                value = value,
                onValueChange = onChange,
                textStyle = monoStyle(fontSize).copy(color = t.text, lineHeight = (fontSize * 1.45f).sp),
                cursorBrush = SolidColor(t.accent),
                visualTransformation = highlight,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii, capitalization = KeyboardCapitalization.None),
                modifier = Modifier.fillMaxWidth().heightIn(min = viewport).focusRequester(focusRequester).padding(10.dp),
            )
        }
    }
}

/** The keys a phone keyboard hides: brackets, quotes, operators, and completions of the word at the cursor. */
@Composable
fun EditorAccessoryBar(value: TextFieldValue, onChange: (TextFieldValue) -> Unit, language: QueryLanguage, names: List<String>, showSymbols: Boolean) {
    val t = bd
    val suggestions = completions(value, language, names)
    val symbols = when (language) {
        QueryLanguage.SQL -> listOf("*", ",", "(", ")", "'", ";", "=", ".", "<", ">", "`", "\"", "%", "_")
        QueryLanguage.MONGO -> listOf("{", "}", ":", "\"", ",", "(", ")", "[", "]", ".", "$", ";")
        QueryLanguage.REDIS -> listOf("\"", "*", ":", "'", "-", "_")
    }
    if (suggestions.isEmpty() && !showSymbols) return
    Row(
        Modifier.fillMaxWidth().background(t.chrome).horizontalScroll(rememberScrollState()).padding(horizontal = 6.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        suggestions.forEach { s ->
            Key(s, accent = true) { onChange(applyCompletion(value, s, language)) }
        }
        if (showSymbols) symbols.forEach { s ->
            Key(s) { onChange(insertAtCursor(value, s)) }
        }
        if (showSymbols) Key("⇥") { onChange(insertAtCursor(value, "  ")) }
    }
}

@Composable
private fun Key(label: String, accent: Boolean = false, onClick: () -> Unit) {
    val t = bd
    Text(
        label,
        color = if (accent) t.accent else t.text,
        style = monoStyle(14),
        modifier = Modifier
            .clip(RoundedCornerShape(5.dp))
            .background(if (accent) t.selection else t.field)
            .clickable(onClick = onClick)
            .padding(horizontal = if (label.length == 1) 13.dp else 9.dp, vertical = 7.dp),
    )
}
