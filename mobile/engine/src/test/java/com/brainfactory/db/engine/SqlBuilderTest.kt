package com.brainfactory.db.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SqlBuilderTest {
    private val mysql = SqlBuilder(SqlDialect.MYSQL)
    private val pg = SqlBuilder(SqlDialect.POSTGRES)
    private val sqlite = SqlBuilder(SqlDialect.SQLITE)
    private val users = TableRef("shop", "public", "users")

    @Test
    fun browseWithFiltersSortAndPaging() {
        val request = BrowseRequest(
            limit = 50, offset = 100,
            sort = listOf(SortSpec("name"), SortSpec("id", descending = true)),
            filters = listOf(FilterSpec("city", FilterOp.EQ, "Jakarta"), FilterSpec("email", FilterOp.CONTAINS, "50%_x"), FilterSpec("note", FilterOp.IS_NULL)),
            rawFilter = "age > 30",
        )
        val b = mysql.browse(users, request)
        assertEquals(
            "SELECT * FROM `shop`.`users` WHERE `city` = ? AND `email` LIKE ? AND `note` IS NULL AND (age > 30) ORDER BY `name` ASC, `id` DESC LIMIT 50 OFFSET 100",
            b.sql,
        )
        assertEquals(listOf("Jakarta", "%50\\%\\_x%"), b.params)
        assertEquals(
            "SELECT * FROM `shop`.`users` WHERE `city` = 'Jakarta' AND `email` LIKE '%50\\\\%\\\\_x%' AND `note` IS NULL AND (age > 30) ORDER BY `name` ASC, `id` DESC LIMIT 50 OFFSET 100",
            b.inline(SqlDialect.MYSQL),
        )
    }

    @Test
    fun postgresComparesTextCaseInsensitively() {
        val b = pg.browse(users, BrowseRequest(limit = 10, filters = listOf(FilterSpec("age", FilterOp.STARTS_WITH, "4"))))
        assertEquals("SELECT * FROM \"public\".\"users\" WHERE CAST(\"age\" AS TEXT) ILIKE ? LIMIT 10", b.sql)
    }

    @Test
    fun sqliteNamesItsLikeEscape() {
        val b = sqlite.browse(TableRef(null, null, "t"), BrowseRequest(limit = 5, filters = listOf(FilterSpec("a", FilterOp.NOT_CONTAINS, "x"))))
        assertEquals("SELECT * FROM \"t\" WHERE \"a\" NOT LIKE ? ESCAPE '\\' LIMIT 5", b.sql)
    }

    @Test
    fun rawWhereKeywordIsOptional() {
        assertEquals(" WHERE (a = 1)", mysql.where(BrowseRequest(rawFilter = "WHERE a = 1"), mutableListOf()))
    }

    @Test
    fun updateByKey() {
        val b = mysql.update(users, mapOf("id" to 7L), "city", CellInput.Text("Bogor"))
        assertEquals("UPDATE `shop`.`users` SET `city` = ? WHERE `id` = ? LIMIT 1", b.sql)
        assertEquals(listOf<Any?>("Bogor", 7L), b.params)
        assertEquals("UPDATE \"public\".\"users\" SET \"city\" = NULL WHERE \"a\" = ? AND \"b\" IS NULL", pg.update(users, mapOf("a" to 1, "b" to null), "city", CellInput.Null).sql)
        assertThrows(DbException::class.java) { mysql.update(users, emptyMap(), "city", CellInput.Null) }
    }

    @Test
    fun insertWithValuesNullsAndDefaults() {
        val b = pg.insert(users, linkedMapOf("name" to CellInput.Text("Ayu"), "note" to CellInput.Null, "id" to CellInput.Default))
        assertEquals("INSERT INTO \"public\".\"users\" (\"name\", \"note\") VALUES (?, NULL)", b.sql)
        assertEquals("INSERT INTO `shop`.`users` () VALUES ()", mysql.insert(users, mapOf("id" to CellInput.Default)).sql)
        assertEquals("INSERT INTO \"t\" DEFAULT VALUES", sqlite.insert(TableRef(null, null, "t"), emptyMap()).sql)
    }

    @Test
    fun deleteSeveralRows() {
        val b = mysql.delete(users, listOf(mapOf("id" to 1), mapOf("id" to 2)))
        assertEquals("DELETE FROM `shop`.`users` WHERE (`id` = ?) OR (`id` = ?)", b.sql)
        assertEquals("DELETE FROM `shop`.`users` WHERE (`id` = 1) OR (`id` = 2)", b.inline(SqlDialect.MYSQL))
    }

    @Test
    fun inlineLeavesQuestionMarksInStringsAlone() {
        assertEquals("SELECT '?' , 5", BoundSql("SELECT '?' , ?", listOf(5)).inline(SqlDialect.MYSQL))
    }
}
