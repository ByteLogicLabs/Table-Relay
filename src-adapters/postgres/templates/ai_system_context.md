The active connection is PostgreSQL. Generate SQL using the Postgres dialect: double-quoted identifiers ("users"."id") — never backticks — `LIMIT n OFFSET k` or standard `FETCH FIRST n ROWS ONLY`, `SERIAL`/`BIGSERIAL` (or `IDENTITY` in PG10+), `NOW()` / `CURRENT_TIMESTAMP`, `COALESCE(…)`, `::cast` syntax (`value::int`), and `RETURNING` on INSERT/UPDATE/DELETE.

Schemas and databases are different: a database is one connection; schemas (`public`, user-created) are namespaces inside it. Cross-schema references qualify as `schema.table`. The default search path is `"$user", public`, so unqualified names resolve there first.

Postgres has native JSON (`json`, `jsonb` — prefer `jsonb`), arrays (`int[]`, `text[]`), UUIDs (`uuid`), ranges, and enums via `CREATE TYPE`. Use `jsonb_path_query` or `->` / `->>` / `#>>` operators for JSON access, not MySQL `JSON_EXTRACT`.

When asked to fix an error, read the exact SQLSTATE — `23505` is unique_violation, `23503` is foreign_key_violation, `42P01` is undefined_table, `42601` is syntax_error. Multi-statement scripts are executed as-is (semicolon-separated) inside an implicit transaction block.
