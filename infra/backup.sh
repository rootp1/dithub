#!/bin/sh
# Nightly backup of everything that exists only on this server: the SQLite index, the bare git repos (the only copy of
# private and >2 MB public code while Swarm is off), the Bee node identity, and the env files holding the server's keys.
# Installed by /etc/cron.d/dithub-backup. Restore notes: docs/base-mainnet.md.
set -eu
DEST=${BACKUP_DIR:-/opt/dheet-backups/daily}
KEEP_DAYS=${KEEP_DAYS:-14}
API=${API_CONTAINER:-dheet-prod-api-1}
umask 077
out="$DEST/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"

# Consistent online copy (safe while api and worker write: VACUUM INTO reads one snapshot of the WAL database).
docker exec "$API" bun -e "import { Database } from 'bun:sqlite'; const d = new Database('/data/db/dithub.sqlite'); d.exec(\"VACUUM INTO '/data/db/.backup.sqlite'\")"
docker cp "$API:/data/db/.backup.sqlite" "$out/dithub.sqlite"
docker exec "$API" rm -f /data/db/.backup.sqlite

docker run --rm -v dheet-prod_repos:/src:ro -v "$out":/out alpine tar -czf /out/repos.tgz -C /src .
docker run --rm -v dheet-prod_beemainnet:/src:ro -v "$out":/out alpine tar -czf /out/beemainnet.tgz -C /src .
cp -p /opt/dheet/infra/prod.env "$out/prod.env"
[ -f /opt/dheet/infra/.env.bee ] && cp -p /opt/dheet/infra/.env.bee "$out/env.bee"

find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "$(date -u +%FT%TZ) backup ok: $out ($(du -sh "$out" | cut -f1))"
