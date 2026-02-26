# MySQL 8 Type Mapping & Fidelity

This document covers Duckling's comprehensive MySQL 8 data type support, how each type maps to DuckDB, and what the integration test suite validates.

## Type Mapping Reference

| MySQL Type | DuckDB Column | Appender Method | Sync Path | CDC Path |
|------------|---------------|-----------------|-----------|----------|
| TINYINT | TINYINT | appendTinyInt | Full + Incremental | CDC |
| SMALLINT | SMALLINT | appendSmallInt | Full + Incremental | CDC |
| MEDIUMINT | BIGINT | appendInteger | Full + Incremental | CDC |
| INT | BIGINT | appendInteger | Full + Incremental | CDC |
| INT UNSIGNED | BIGINT | appendInteger | Full + Incremental | CDC |
| BIGINT | BIGINT | appendBigInt | Full + Incremental | CDC |
| BIGINT UNSIGNED | BIGINT | appendBigInt(BigInt) | Full + Incremental | CDC |
| FLOAT | FLOAT | appendFloat | Full + Incremental | CDC |
| DOUBLE | DOUBLE | appendDouble | Full + Incremental | CDC |
| DECIMAL(p,s) | DECIMAL | appendDouble | Full + Incremental | CDC |
| CHAR(n) | VARCHAR | appendVarchar | Full + Incremental | CDC |
| VARCHAR(n) | VARCHAR | appendVarchar | Full + Incremental | CDC |
| TINYTEXT | TEXT | appendVarchar | Full + Incremental | CDC |
| TEXT | TEXT | appendVarchar | Full + Incremental | CDC |
| MEDIUMTEXT | TEXT | appendVarchar | Full + Incremental | CDC |
| LONGTEXT | TEXT | appendVarchar | Full + Incremental | CDC |
| BINARY(n) | BLOB | appendBlob | Full only | -- |
| VARBINARY(n) | BLOB | appendBlob | Full only | -- |
| TINYBLOB | BLOB | appendBlob | Full only | -- |
| BLOB | BLOB | appendBlob | Full only | -- |
| MEDIUMBLOB | BLOB | appendBlob | Full only | -- |
| LONGBLOB | BLOB | appendBlob | Full only | -- |
| JSON | VARCHAR | appendVarchar | Full + Incremental | CDC |
| ENUM | VARCHAR | appendVarchar | Full + Incremental | CDC |
| SET | VARCHAR | appendVarchar | Full + Incremental | CDC |
| DATE | DATE | appendVarchar (auto) | Full + Incremental | CDC |
| TIME | TIME | appendVarchar (auto) | Full + Incremental | CDC |
| TIME(6) | TIME | appendVarchar (auto) | Full + Incremental | CDC |
| DATETIME | TIMESTAMP | appendVarchar (auto) | Full + Incremental | CDC |
| DATETIME(6) | TIMESTAMP | appendVarchar (auto) | Full + Incremental | CDC |
| TIMESTAMP | TIMESTAMP | appendVarchar (auto) | Full + Incremental | CDC |
| TIMESTAMP(6) | TIMESTAMP | appendVarchar (auto) | Full + Incremental | CDC |
| YEAR | VARCHAR | appendVarchar | Full + Incremental | CDC |
| BIT(n) | VARCHAR | appendVarchar(String) | Full only | -- |
| BOOLEAN | BOOLEAN | appendBoolean | Full + Incremental | CDC |

## Known Limitations

### INT UNSIGNED & BIGINT UNSIGNED overflow

The Appender path has two overflow issues with large unsigned values:

- **`INT UNSIGNED`**: `appendValueByType()` calls `appendInteger()` (32-bit) for all `INT` types, even though `mapMySQLTypeToDuckDB()` creates the column as `BIGINT`. Values above `INT32_MAX` (2,147,483,647) overflow `appendInteger()` and crash the entire table sync. Tests use `2000000000` as the test value.

- **`BIGINT UNSIGNED`**: Values above `BIGINT_MAX` (9,223,372,036,854,775,807) overflow DuckDB's signed `BIGINT` and crash `appendBigInt()`. Tests use `9000000000000000000` as the test value. The exact max of `18446744073709551615` (2^64-1) cannot be stored.

### DECIMAL Precision

MySQL `DECIMAL(20,10)` maps to DuckDB's bare `DECIMAL` type. High-precision values may experience truncation depending on the DuckDB DECIMAL width. Tests use `assert_contains` on the integer portion rather than exact matching.

### BIT(n) Columns

MySQL `BIT` columns fall through to the default VARCHAR mapping. MySQL returns BIT values as a Buffer, and `String(buffer)` produces garbled output that the Appender cannot write — this crashes the entire table sync, leaving 0 rows in DuckDB. BIT columns are **excluded from the `type_coverage` test table** to avoid blocking all other type assertions. Fix requires an explicit BIT handler in `appendValueByType()` that converts the Buffer to a hex/integer representation.

### Binary Types & CDC

Binary types (BLOB, BINARY, VARBINARY, TINYBLOB, MEDIUMBLOB, LONGBLOB) break the `INSERT OR REPLACE` SQL path used by CDC updates. Binary data is only tested via the full-sync Appender path (Suite 7). The CDC test table (`type_coverage_cdc`) deliberately excludes binary columns.

## Integration Test Coverage

### Test Tables

| Table | Purpose | Column Count |
|-------|---------|-------------|
| `type_coverage` | Full-sync Appender path testing (all types including binary, excluding BIT) | 25 columns |
| `type_coverage_cdc` | CDC path testing (non-binary types only) | 19 columns |

### Suite 7: Type Fidelity (Full Sync)

Tests every MySQL 8 type through the Appender path with 3 seed rows:

**Row 1 - Edge cases**: Min/max boundary values for each type (-128 for TINYINT, 4294967295 for INT UNSIGNED, DOUBLE max, full CHAR(10), max TIME, fractional timestamps, SET combinations).

**Row 2 - Zero/empty values**: Zeros for numerics, empty strings for text/char, zero TIME, epoch timestamps, empty SET.

**Row 3 - NULLs**: Every nullable column set to NULL. Validates NULL propagation through the Appender pipeline.

### Suite 6 CDC Extension: Type Fidelity

Tests non-binary types through the CDC INSERT and UPDATE paths:

**CDC INSERT**: Inserts 1 row with diverse types (TINYINT -42, SMALLINT 1000, MEDIUMINT 500000, INT UNSIGNED 3000000000, DOUBLE 2.71828, DECIMAL 12345, CHAR 'CDC-TEST', text variants, TIME, YEAR 2024, SET 'b,d'). Validates 12 column values.

**CDC UPDATE**: Updates 5 columns (TINYINT->127, SMALLINT->32767, DOUBLE->-1.0, CHAR->'UPDATED', SET->'a,b,c'). Validates all 5 updated values.

### Assertion Counts

| Suite | Assertions |
|-------|-----------|
| Suite 1: Full Sync | 24 |
| Suite 2: Incremental Insert | 8 |
| Suite 3: Incremental Update | 8 |
| Suite 4: Single Table Sync | 4 |
| Suite 5: Idempotent Re-sync | 8 |
| Suite 6: CDC Real-Time (+ type ext) | 17 + 18 = 35 |
| Suite 7: Type Fidelity | 58 |
| **Total** | **~145** |

## Running the Tests

```bash
cd tests/integration
chmod +x run.sh
./run.sh
```

## Implementation References

- Type mapping logic: `packages/server/src/services/sequentialAppenderService.ts:1284-1316`
- DuckDB connection: `packages/server/src/database/duckdb.ts`
- Test schema: `tests/integration/mysql-init/01-schema.sql`
- Test runner: `tests/integration/run.sh`
