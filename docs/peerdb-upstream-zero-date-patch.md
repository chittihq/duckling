# PeerDB Upstream Patch Note: Zero-Date Handling

> **Status (2026-06-06): SOLVED in-repo, pending upstream.** The v3 patch
> ([peerdb-upstream-zero-date-poc-v3.patch](peerdb-upstream-zero-date-poc-v3.patch))
> adds a `PEERDB_MYSQL_ZERO_DATE_AS_NULL` dynamic setting (default `false`)
> that converts full-zero (`0000-00-00`) and partial-zero (`2024-00-15`)
> dates/timestamps to NULL at the row-read layer — in both the snapshot
> (`QValueFromMysqlFieldValue`) and CDC (`QValueFromMysqlRowEvent`) paths,
> before the value collapses into `time.Time`. Verified end-to-end against
> v0.36.19: `tests/peerdb/run-type-coverage.sh` with `PEERDB_ZERO_DATE_AS_NULL=true`
> hard-asserts NULL for both full-sync and CDC, and passes. Build the patched
> images with `scripts/build-peerdb-zero-date-poc.sh` (defaults to v3 against
> the v0.36.19 tag). Pair the setting with `PEERDB_NULLABLE=true` so the
> destination column is Nullable. The v1/v2 patches below are superseded —
> they worked at Avro-staging level and could not distinguish a real epoch
> value from a coerced zero-date. The separate `1000-01-01` → Date32 range
> clamp issue is NOT addressed by this patch.

## Problem

Duckling's PeerDB type-coverage gate narrowed the remaining incompatibility to
MySQL zero-date handling on the ClickHouse path.

Observed behavior:

- full sync:
  - `0000-00-00` becomes `1970-01-01`
  - `1000-01-01` / partial-zero variants do not round-trip as expected
- CDC:
  - `0000-00-00` becomes `1970-01-01`

Tried workaround:

- override `col_date_zero -> String` in PeerDB mirror `ColumnSetting`

Result:

- mirror creation succeeds
- snapshot fails because the staged Avro schema still carries Avro logical `date`
  for the source column, while ClickHouse destination now expects `String`

Representative error:

```text
Type String is not compatible with Avro int:
{"type":"int","logicalType":"date"}
```

## Root cause

PeerDB's ClickHouse custom destination-type conversion path currently only
supports numerics.

Relevant file:

- `/tmp/peerdb-src/flow/connectors/clickhouse/type_conversion.go`

Current state:

- `SupportedDestinationTypes["String"]` only maps numeric kinds via:
  - `NumericToStringSchemaConversion`
  - `NumericToStringValueConversion`
- `findTypeConversions(...)` therefore never matches `QValueKindDate`,
  `QValueKindTimestamp`, or `QValueKindTime`

Related snapshot Avro path:

- `flow/connectors/clickhouse/avro_sync.go`
  - `getAvroSchema(...)`
- `flow/model/conversion_avro.go`
  - `GetAvroSchemaDefinition(...)`
- `flow/model/qvalue/avro_converter.go`
  - `GetAvroSchemaFromQValueKind(...)`

## Likely upstream fix

Add ClickHouse destination-type conversions for date-like source kinds when
`DestinationType == "String"`.

At minimum:

- `QValueKindDate -> String`
- likely also:
  - `QValueKindTimestamp -> String`
  - `QValueKindTimestampTZ -> String`
  - `QValueKindTime -> String`
  - `QValueKindTimeTZ -> String`

That requires:

1. add new `TypeConversion` implementations in PeerDB shared type-conversion code
   so both schema and value are converted before Avro staging
2. register those conversions in
   `flow/connectors/clickhouse/type_conversion.go`
3. rerun the ClickHouse snapshot path so Avro emits `string` instead of logical
   `date` / `timestamp-*` for overridden columns

Repo-local proof-of-concept patch:

- [peerdb-upstream-zero-date-poc.patch](/Users/jMac/Projects/LMES/duckling/docs/peerdb-upstream-zero-date-poc.patch)
- [peerdb-upstream-zero-date-poc-v2.patch](/Users/jMac/Projects/LMES/duckling/docs/peerdb-upstream-zero-date-poc-v2.patch)
- [build-peerdb-zero-date-poc.sh](/Users/jMac/Projects/LMES/duckling/scripts/build-peerdb-zero-date-poc.sh)

Current helper default:

- `build-peerdb-zero-date-poc.sh` now defaults to the stronger `poc-v2` patch
- override with `PEERDB_PATCH_FILE=/abs/path/to/patch` if needed

The first patch takes the initial step by making MySQL source schema generation
honor `DestinationType == "String"` for date/time-like columns.

The second patch extends PeerDB's ClickHouse destination-type conversion map so
`QValueKindDate -> String` is a supported conversion during Avro staging.

Those changes are likely necessary but still need full end-to-end verification
after rebuilding PeerDB.

## Why this matters

Without this upstream patch, Duckling cannot truthfully claim complete MySQL
type compatibility on the PeerDB -> ClickHouse path for zero/partial-zero dates.
