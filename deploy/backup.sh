#!/bin/bash
# Compressed dump of the database, plus a restore command in the log so it is never a mystery.
# Run once, or with --loop to keep dumping every night.
set -euo pipefail

DEST=${BACKUP_DIR:-/backups}
KEEP=${BACKUP_KEEP_DAYS:-14}

dump_once() {
    mkdir -p "$DEST"
    local stamp file
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    file="$DEST/${PGDATABASE:-oceanspill}-$stamp.dump"
    pg_dump --format=custom --compress=9 --file="$file"
    echo "$(date -u +%FT%TZ) wrote $file ($(du -h "$file" | cut -f1))"
    echo "  restore with: pg_restore --clean --if-exists --dbname=\$PGDATABASE $file"
    find "$DEST" -name '*.dump' -type f -mtime "+$KEEP" -print -delete
}

if [[ ${1:-} == "--loop" ]]; then
    while true; do
        dump_once || echo "$(date -u +%FT%TZ) backup failed" >&2
        # Next 02:30 UTC.
        target=$(date -u -d 'tomorrow 02:30' +%s 2>/dev/null || date -u -v+1d -v2H -v30M -v0S +%s)
        sleep $(( target - $(date -u +%s) ))
    done
fi

dump_once
