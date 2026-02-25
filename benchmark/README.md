# Duckling Benchmark: MySQL vs DuckDB

Benchmark suite comparing MySQL and DuckDB (via Duckling) query performance on **20 million rows**.

## Quick Start

```bash
cd benchmark
./run.sh
```

That's it. The script handles everything:

1. **Starts MySQL** container with schema
2. **Seeds 20M rows** (100K users, 10K products, 20M orders)
3. **Starts Duckling** server (builds from source)
4. **Syncs MySQL → DuckDB** via Duckling's full sync
5. **Runs 8 analytical queries** against both MySQL and DuckDB
6. **Prints comparison** table with speedup ratios

## Adjusting Scale

Control the dataset size with `BENCHMARK_SCALE`:

```bash
# Smoke test (~200K orders, ~2 min)
BENCHMARK_SCALE=0.01 ./run.sh

# Quick test (~2M orders, ~5 min)
BENCHMARK_SCALE=0.1 ./run.sh

# Full benchmark (~20M orders, ~30 min)
./run.sh

# Large benchmark (~40M orders, ~60 min)
BENCHMARK_SCALE=2 ./run.sh
```

## Benchmark Queries

| # | Query | What it tests |
|---|-------|---------------|
| Q1 | `COUNT(*)` full table | Full table scan |
| Q2 | `COUNT(*)` with `WHERE` filter | Filtered scan |
| Q3 | `GROUP BY status` with `AVG()` | Single-column aggregation |
| Q4 | `GROUP BY region, status` | Multi-column aggregation |
| Q5 | Monthly revenue for 2023 | Date range + temporal aggregation |
| Q6 | Top 10 users by spend | Sort + limit on aggregation |
| Q7 | Regional analytics with `COUNT(DISTINCT)` | Complex multi-metric aggregation |
| Q8 | `JOIN users + orders` with `GROUP BY` | Join + aggregation |

## Data Schema

```
users     (100,000 rows)  → id, name, email, region, created_at, updated_at
products  ( 10,000 rows)  → id, name, category, price, created_at, updated_at
orders    (20,000,000 rows) → id, user_id, product_id, quantity, unit_price,
                              total_amount, status, region, order_date,
                              created_at, updated_at
```

## GitHub Actions

The benchmark runs automatically on PRs that modify `benchmark/**` files, or can be triggered manually:

```yaml
# Manual trigger from GitHub Actions UI
gh workflow run benchmark.yml
```

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│   MySQL 8   │────→│  Duckling Server │────→│   DuckDB     │
│  (source)   │     │  (sync + API)    │     │  (columnar)  │
│  20M rows   │     │                  │     │  20M rows    │
└─────────────┘     └──────────────────┘     └──────────────┘
       ↑                     ↑                       ↑
       │              POST /sync/full          POST /api/query
       │              triggers replication    database: "duckdb"
       │
  POST /api/query
  database: "mysql"
```

Both MySQL and DuckDB queries go through the same Duckling API endpoint (`POST /api/query`), ensuring a fair comparison with identical network overhead.

## Requirements

- Docker with Compose plugin
- `curl`, `jq`, `bc`, `sed` (standard on Linux/macOS)
- ~4GB free RAM, ~10GB free disk

## Output

Results are printed to stdout and saved to `benchmark-results.md` in Markdown table format, suitable for pasting into GitHub issues or PRs.
