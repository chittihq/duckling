# Deployment Guide

Duckling is a ClickHouse-backed analytical replica for MySQL. The default deployment is **peerdb-primary**: real binlog CDC via the bundled PeerDB stack, with duckling's 1-second polling as the automatic fallback for sources that can't do CDC.

## TL;DR — self-host

```bash
curl -O https://raw.githubusercontent.com/chittihq/duckling/main/docker-compose.yml
docker compose up -d
docker compose logs duckling | grep -A6 generated   # one-time credentials
```

Open `http://<host>:3000`, log in, and add your MySQL database from the dashboard. Done — the capability probe picks `peerdb` (binlog CDC) or `polling` per database automatically.

## What the default compose runs

| Service | Image | Purpose |
|---|---|---|
| `duckling` | `chittihq/duckling:0.5.0` (pinned; override via `DUCKLING_IMAGE`) | Dashboard + REST API + WebSocket (port **3000**), MySQL wire protocol (port **3307**) |
| `clickhouse` | `clickhouse/clickhouse-server:25.8` | The analytical store — your replicated data lives here |
| `flow-api`, `flow-worker`, `flow-snapshot-worker` | `chittihq/peerdb-flow-*:v0.36.19-zerodate-v3` | PeerDB CDC engine (**zero-date-patched builds** — stock upstream v0.36 corrupts MySQL `0000-00-00`) |
| `peerdb` | `ghcr.io/peerdb-io/peerdb-server` | PeerDB SQL control surface |
| `catalog` | `postgres:18-alpine` | PeerDB catalog |
| `temporal` + `temporal-admin-tools` | `temporalio/*` | PeerDB workflow engine |
| `rustfs` | `rustfs/rustfs` | S3-compatible staging for CDC batches |

Only `duckling` publishes host ports (3000, 3307). Everything else is internal to the compose network — **do not add host ports to catalog/temporal/flow services on an internet-facing machine**.

Debug UIs are opt-in:

```bash
docker compose --profile debug up -d   # PeerDB UI :13003, Temporal UI :18233
```

## Configuration

**None required.** On first boot duckling generates the admin password, API key, and session secret, persists them to the `duckling-data` volume (`.secrets.json`), and prints them once in the logs.

Optional overrides (set in the compose or a `.env` next to it):

| Variable | Default | Why override |
|----------|---------|--------------|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | auto-generated | Pin dashboard credentials |
| `DUCKLING_API_KEY` | auto-generated | Pin the superuser API key |
| `SESSION_SECRET` | auto-generated | Pin JWT signing |
| `MYSQL_CONNECTION_STRING` | unset | Auto-create one default database from env (otherwise add via UI) |
| `TRUST_PROXY` | `uniquelocal` | Which peers may set `X-Forwarded-For`. The compose default trusts only private-network peers — a reverse proxy on the Docker network (Traefik/Nginx/Dokploy) — so rate limiting keys on the real client IP behind a proxy, while a client reaching published port 3000 directly (public source IP) cannot spoof its address. Use `<n>` hops only if your proxy connects from a public IP |
| `PEERDB_SQL_PASSWORD`, `PEERDB_CATALOG_PASSWORD`, `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY` | dev defaults | Harden internal PeerDB credentials (compose-network-internal either way) |
| `CLICKHOUSE_FINAL_READS` | `true` | Leave on — guarantees deduplicated reads in peerdb mode |

Full list: `.env.example` and `packages/server/src/config.ts`.

## Persistence

Named volumes — nothing to map by hand, works the same under the Compose CLI or Dokploy's Compose deploy:

| Volume | Contents |
|--------|----------|
| `clickhouse-data` | **Your replicated data** (back this one up) |
| `duckling-data` | `databases.json` (per-database config incl. connection strings + API key hashes) + generated secrets |
| `catalog-data` | PeerDB catalog (mirror state, replication progress) |
| `rustfs-data` | Transient CDC staging |

For off-host backups, use the built-in S3 backups (`/backups` dashboard page or `/api/databases/:id/backups`) — ClickHouse-native `BACKUP TO S3(...)` against AWS S3 or any S3-compatible store.

### Putting the data on an attached volume

Named volumes live under `/var/lib/docker/volumes` on the host's **boot disk**. If you attached a dedicated block volume (DigitalOcean Volumes, Hetzner Volumes, EBS), the data does *not* move there on its own — the compose has to say so.

Note that the volume that grows is `clickhouse-data`, and it belongs to the ClickHouse container. duckling's own `/app/data` is kilobytes (`databases.json`, secrets, logs), so relocating it with `DATA_PATH` does nothing for disk pressure.

**1. Prepare the host** (once). The directories must exist before the stack starts — a bind-backed volume fails to mount rather than creating them:

```bash
export ROOT=/mnt/YOUR_VOLUME/duckling          # your attached volume's mount point
sudo mkdir -p $ROOT/{clickhouse,duckling,rustfs,catalog}
sudo chown -R 10001:10001 $ROOT/rustfs         # RustFS runs as uid 10001
```

Only RustFS needs the `chown`: ClickHouse, Postgres, and duckling all start as root and fix their own ownership. Confirm the volume remounts on reboot with `grep /mnt /etc/fstab`.

**2. Enable the storage block** in `docker-compose.yml` — uncomment the `driver_opts` volumes block at the bottom of the file and set the mount point in the environment:

```bash
DUCKLING_STORAGE_ROOT=/mnt/YOUR_VOLUME/duckling
```

Commit the uncommented block to the compose you deploy from. Platforms that re-clone the repo on every deploy (Dokploy) overwrite edits made on the server, but read `DUCKLING_STORAGE_ROOT` from their own environment settings — so the path itself stays out of git.

**3. Move existing data, if any.** Docker will not repoint a volume that already exists, so the old ones have to go. To keep the data, copy it first — `cp -a` preserves the ownership the containers set:

```bash
docker compose -p YOUR_PROJECT down
docker volume ls | grep duckling               # volumes are prefixed with the project name
for v in clickhouse duckling rustfs catalog; do
  sudo cp -a /var/lib/docker/volumes/YOUR_PROJECT_${v}-data/_data/. $ROOT/${v}/
done
docker volume rm YOUR_PROJECT_clickhouse-data YOUR_PROJECT_duckling-data \
                 YOUR_PROJECT_rustfs-data YOUR_PROJECT_catalog-data
```

Starting fresh instead? Just remove the volumes — but set `ADMIN_PASSWORD` and `DUCKLING_API_KEY` explicitly first, since discarding `duckling-data` discards the generated ones.

**4. Verify.** Every boot prints the resolved paths and their capacity:

```
💾 Storage locations:
   duckling data:  /app/data — 495 GB free of 500 GB
   ClickHouse "default": /var/lib/clickhouse/ — 495 GB free of 500 GB
```

If the reported capacity is the boot disk's rather than the attached volume's, the mount did not take effect. `df -h $ROOT` and `du -sh $ROOT/*` confirm it from the host side.

> Moving Docker's entire data root (`{"data-root": "..."}` in `/etc/docker/daemon.json`) is the alternative — it relocates images and build cache too, which is what usually fills a boot disk. It also relocates every other container on the host, so treat it as a maintenance-window change rather than part of this one.

## Sizing

The PeerDB stack wants roughly **4 GB RAM** on top of duckling + ClickHouse; plan ~8 GB total for a small production host. If you only need polling mode on a tiny host: remove the PeerDB services from the compose and pin databases to `replicationMode: 'polling'` — duckling runs fine with just `clickhouse` + `duckling`.

## Replication modes

Decided **per database, before any data moves**, by a capability probe (`log_bin=ON`, `binlog_format=ROW`, `binlog_row_image=FULL`, `binlog_row_metadata=FULL`, `REPLICATION SLAVE`/`CLIENT` grants):

- **CDC-capable source → `peerdb`**: PeerDB does the initial snapshot AND streams binlog changes, end-to-end. Deletes are tombstoned correctly.
- **Not capable → `polling`**: duckling dumps the source, then polls row counts/change tokens every second. Near-real-time for inserts/updates; see README "Known limitations" for the delete blind spot.

The dashboard's **Diagnose** button shows the full checklist with ✓/✗ per requirement — run it on any new source. Managed-MySQL note: `binlog_row_metadata` commonly defaults to `MINIMAL` (e.g. DigitalOcean); flip it to `FULL` in the provider's advanced config to unlock CDC. Also check binlog retention — with short retention (e.g. 3 days), a CDC pipeline stalled longer than that loses its position and needs a re-snapshot.

## Dokploy

Use the Compose deploy type pointed at `docker-compose.yml`. Named volumes mean no host-path configuration in the UI. For the domain: service `duckling`, container port `3000`. `TRUST_PROXY=uniquelocal` is already the compose default, matching Dokploy's Traefik-fronted topology (Traefik reaches the container over the private Docker network, so its forwarded client IPs are trusted; direct hits on the published port are not).

## Health & monitoring

- `GET /health` — liveness
- `GET /status` — replication + connection status
- `GET /metrics` — metrics endpoint
- `docker compose logs -f duckling` — structured JSON logs (stdout, ready for ELK/Datadog/CloudWatch)

## Upgrades

The compose pins `chittihq/duckling` to an exact release tag, so upgrades are explicit: pull the latest repo (each release bumps the pinned tag), then

```bash
git pull && docker compose pull && docker compose up -d
```

To run a different version without editing the file, set `DUCKLING_IMAGE=chittihq/duckling:<tag>` in the environment. Avoid `:latest` in deployments — `docker compose up` reuses a locally cached `latest` and silently skips new releases unless you remember to `pull` first; an exact tag makes every recreate deterministic.

Image tags: `:0.x.y` exact versions (recommended; multi-arch amd64+arm64), `:latest` tracks releases. The patched PeerDB flow images are pinned by exact version tag and only change when the upstream PeerDB pin is bumped (see `.github/workflows/publish-peerdb-patched.yml`).

## Migrating from the old DuckDB deployment

The DuckDB runtime is retired. There is no in-place data migration — stand up the new stack and re-bootstrap:

1. Deploy this compose alongside (or after stopping) the old instance.
2. Add your MySQL databases in the dashboard — the initial load re-dumps from MySQL (the source of truth), so nothing from the old DuckDB volume is needed.
3. Point SDK / wire-protocol clients at the new host, then archive and remove the old volume.

## Development

Local development doesn't use this compose — see `README.md` (Development) for the dev stack (`docker-compose.dev.yml`, source builds + hot reload) and `CLAUDE.md` for the full development guide.
