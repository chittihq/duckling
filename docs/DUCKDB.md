# DuckDB Reference

This document covers DuckDB-specific features and operations used in Duckling.

## ALTER TABLE Operations

DuckDB supports the following ALTER TABLE operations for schema evolution.

Reference: [DuckDB ALTER TABLE Documentation](https://duckdb.org/docs/stable/sql/statements/alter_table)

### Supported Operations

| Operation | Syntax | Status |
|-----------|--------|--------|
| **ADD COLUMN** | `ALTER TABLE t ADD COLUMN col TYPE` | Supported |
| **DROP COLUMN** | `ALTER TABLE t DROP COLUMN col` | Supported |
| **RENAME COLUMN** | `ALTER TABLE t RENAME COLUMN old TO new` | Supported |
| **ALTER TYPE** | `ALTER TABLE t ALTER col TYPE VARCHAR` | Supported |
| **SET DEFAULT** | `ALTER TABLE t ALTER col SET DEFAULT 10` | Supported |
| **DROP DEFAULT** | `ALTER TABLE t ALTER col DROP DEFAULT` | Supported |
| **ADD PRIMARY KEY** | `ALTER TABLE t ADD PRIMARY KEY (col)` | Supported |
| **RENAME TABLE** | `ALTER TABLE t RENAME TO new_name` | Supported |

### Examples

```sql
-- Add column with default
ALTER TABLE User ADD COLUMN status VARCHAR DEFAULT 'active';

-- Add column (NULL default)
ALTER TABLE User ADD COLUMN middle_name VARCHAR;

-- Drop column
ALTER TABLE User DROP COLUMN old_field;

-- Change column type
ALTER TABLE User ALTER COLUMN age TYPE BIGINT;

-- Change type with conversion expression
ALTER TABLE User ALTER COLUMN id SET DATA TYPE VARCHAR USING CAST(id AS VARCHAR);

-- Rename column
ALTER TABLE User RENAME COLUMN userName TO user_name;

-- Set default value
ALTER TABLE User ALTER COLUMN status SET DEFAULT 'pending';

-- Remove default value
ALTER TABLE User ALTER COLUMN status DROP DEFAULT;

-- Add primary key
ALTER TABLE User ADD PRIMARY KEY (id);

-- Rename table
ALTER TABLE User RENAME TO Users;
```

### Limitations

| Limitation | Description |
|------------|-------------|
| **Index dependencies** | Cannot alter columns that have indexes (including PRIMARY KEY) |
| **One ALTER per statement** | Multiple changes require multiple ALTER statements |
| **No ADD/DROP CONSTRAINT** | CHECK constraints cannot be added or removed |
| **Views not auto-updated** | Dependent views must be manually updated after renames |
| **Type conversion history** | Type changes may fail if conflicting types existed historically |

### Primary Key Constraint

Columns with PRIMARY KEY cannot be dropped or have their type changed directly:

```sql
-- This will FAIL:
ALTER TABLE User DROP COLUMN id;
-- Error: "Dependency Error: Cannot alter entry because there are entries that depend on it"

-- Workaround: DROP and recreate the table
DROP TABLE User;
CREATE TABLE User (...new schema...);
```

### Transactional Safety

All ALTER TABLE changes are transactional:
- Changes are not visible to other transactions until committed
- Changes can be fully reverted through rollback

## Schema Evolution in Duckling

Duckling automatically handles adding new columns during sync.

### Supported Changes (Automatic)

| Change Type | Handling |
|-------------|----------|
| **New column in MySQL** | Automatically added via `ALTER TABLE ADD COLUMN` |
| **New table in MySQL** | Automatically created |

### Changes Not Handled

| Change Type | Handling |
|-------------|----------|
| **Column removed** | Ignored (extra column remains in DuckDB) |
| **Column type changed** | Ignored (may cause sync errors) |
| **Column renamed** | Treated as new column + removed column |

### How It Works

1. Before each sync, Duckling compares MySQL schema with DuckDB schema
2. New columns are detected and added via `ALTER TABLE ADD COLUMN`
3. Existing data gets `NULL` for new columns
4. Sync continues normally

```
MySQL Schema Change Detected
           │
           ▼
    ┌──────────────┐
    │ Compare with │
    │ DuckDB Schema│
    └──────────────┘
           │
           ▼
    ┌──────────────────┐
    │ New columns?     │
    └──────────────────┘
         │         │
        Yes        No
         │         │
         ▼         ▼
    ┌────────┐  ┌──────────┐
    │ ALTER  │  │ Continue │
    │ TABLE  │  │ sync     │
    │ ADD COL│  └──────────┘
    └────────┘
```

## Performance Considerations

### Appender API vs INSERT

| Method | Throughput | Use Case |
|--------|------------|----------|
| **Appender API** | ~60,000 rows/sec | Full sync (bulk loading) |
| **INSERT OR REPLACE** | ~10,000 rows/sec | Incremental sync (upserts) |

### Storage

DuckDB uses columnar storage with automatic compression:
- Single `.db` file per database
- Automatic WAL management
- VACUUM runs automatically

## References

- [DuckDB Documentation](https://duckdb.org/docs/)
- [ALTER TABLE Statement](https://duckdb.org/docs/stable/sql/statements/alter_table)
- [Appender API](https://duckdb.org/docs/stable/data/appender.html)
- [DuckDB Node.js API](https://duckdb.org/docs/api/nodejs/overview)
