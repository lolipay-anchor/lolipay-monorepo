#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/var/backups/lolipay}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/etc/lolipay/backup.key}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-60}"
PG_CONTAINER="${PG_CONTAINER:-}"
MINIO_CONTAINER="${MINIO_CONTAINER:-}"
COMPOSE_FILE="${COMPOSE_FILE:-/home/lolipay/lolipay-monorepo/services/coordinator/docker-compose.prod.yml}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-lolipayprod}"
PG_USER="${PG_USER:-lolipay}"
PG_DB="${PG_DB:-lolipay}"
OFFSITE_CMD="${BACKUP_OFFSITE_CMD:-}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_TAG="lolipay-backup"

log()  { printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$LOG_TAG" "$*" >&2; }
die()  { printf '%s [%s] FATAL %s\n' "$(date -u +%FT%TZ)" "$LOG_TAG" "$*" >&2; exit 1; }

resolve_container() {
  local service="$1" explicit="$2"
  if [ -n "$explicit" ]; then printf '%s' "$explicit"; return 0; fi
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps -aq "$service" 2>/dev/null | head -1
}

require_running() {
  local name="$1" label="$2"
  [ -n "$name" ] || die "cannot resolve the $label container; set ${label^^}_CONTAINER explicitly"
  local state
  state="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)"
  [ "$state" = "true" ] || die "$label container ($name) is not running; refusing to write a backup that would be empty"
}

preflight() {
  command -v docker >/dev/null || die "docker not found on PATH"
  docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon; this script needs root or docker-group access"

  [ -f "$PASSPHRASE_FILE" ] || die "passphrase file $PASSPHRASE_FILE does not exist; create it with mode 600 before backing up"
  local mode
  mode="$(stat -c '%a' "$PASSPHRASE_FILE")"
  [ "$mode" = "600" ] || [ "$mode" = "400" ] || die "passphrase file $PASSPHRASE_FILE has mode $mode; must be 600 or 400"
  [ -s "$PASSPHRASE_FILE" ] || die "passphrase file $PASSPHRASE_FILE is empty"

  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  local avail_kb
  avail_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
  [ "$avail_kb" -gt 1048576 ] || die "less than 1 GiB free on the backup filesystem; refusing to start"
}

encrypt_to() {
  gpg --batch --yes --quiet --pinentry-mode loopback \
      --passphrase-file "$PASSPHRASE_FILE" \
      --symmetric --cipher-algo AES256 --compress-algo none \
      --output "$1"
}

dump_postgres() {
  local out="$BACKUP_DIR/pg-$STAMP.dump.gpg"
  local tmp="$out.partial"
  log "dumping postgres from container $PG_NAME"
  if ! docker exec "$PG_NAME" pg_dump -Fc -U "$PG_USER" "$PG_DB" | encrypt_to "$tmp"; then
    rm -f "$tmp"
    die "pg_dump failed; no backup written"
  fi
  [ -s "$tmp" ] || { rm -f "$tmp"; die "pg_dump produced an empty file"; }
  mv "$tmp" "$out"
  log "postgres dump written: $out ($(du -h "$out" | cut -f1))"
  printf '%s' "$out"
}

dump_minio() {
  local out="$BACKUP_DIR/minio-$STAMP.tar.gpg"
  local tmp="$out.partial"
  log "archiving minio data from container $MINIO_NAME"
  if ! docker cp "$MINIO_NAME:/data/." - | encrypt_to "$tmp"; then
    rm -f "$tmp"
    die "minio archive failed; no backup written"
  fi
  [ -s "$tmp" ] || { rm -f "$tmp"; die "minio archive produced an empty file"; }
  mv "$tmp" "$out"
  log "minio archive written: $out ($(du -h "$out" | cut -f1))"
  printf '%s' "$out"
}

verify_readable() {
  local f="$1"
  gpg --batch --quiet --pinentry-mode loopback \
      --passphrase-file "$PASSPHRASE_FILE" \
      --decrypt "$f" >/dev/null 2>&1 \
    || die "cannot decrypt $f with the configured passphrase; treating this run as failed"
  log "verified decryptable end to end: $(basename "$f")"
}

ship_offsite() {
  [ -n "$OFFSITE_CMD" ] || { log "WARNING no BACKUP_OFFSITE_CMD configured — these copies live on the same disk as the data they protect, which is not a backup"; return 0; }
  log "shipping off-site"
  for f in "$@"; do
    BACKUP_FILE="$f" bash -c "$OFFSITE_CMD" || die "off-site command failed for $f"
  done
  log "off-site copies confirmed"
}

prune_old() {
  log "pruning backups older than $RETENTION_DAYS days"
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.gpg' -mtime "+$RETENTION_DAYS" -print -delete
}

restore_test() {
  local dump="${1:-}"
  [ -n "$dump" ] || dump="$(ls -1t "$BACKUP_DIR"/pg-*.dump.gpg 2>/dev/null | head -1)"
  [ -n "$dump" ] || die "no postgres dump found to restore-test"
  [ -f "$dump" ] || die "$dump does not exist"

  local scratch="lolipay_restore_test_$$"
  local started
  started="$(date +%s)"
  log "restore test starting: $dump -> database $scratch"

  docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $scratch;" >/dev/null
  docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE $scratch;" >/dev/null

  if ! gpg --batch --quiet --pinentry-mode loopback \
        --passphrase-file "$PASSPHRASE_FILE" --decrypt "$dump" \
      | docker exec -i "$PG_NAME" pg_restore -U "$PG_USER" -d "$scratch" --no-owner --no-privileges; then
    docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $scratch;" >/dev/null || true
    die "pg_restore failed; this backup is NOT usable"
  fi

  local tables
  tables="$(docker exec "$PG_NAME" psql -U "$PG_USER" -d "$scratch" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
  docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $scratch;" >/dev/null

  local elapsed=$(( $(date +%s) - started ))
  [ "$tables" -gt 0 ] || die "restore produced 0 tables; this backup is NOT usable"
  log "restore test PASSED: $tables tables in ${elapsed}s (this is the measured RTO for the database leg)"
}

main() {
  preflight
  PG_NAME="$(resolve_container postgres "$PG_CONTAINER")"
  MINIO_NAME="$(resolve_container minio "$MINIO_CONTAINER")"
  require_running "$PG_NAME" pg
  require_running "$MINIO_NAME" minio

  case "${1:-backup}" in
    backup)
      local pg_file minio_file
      pg_file="$(dump_postgres)"
      minio_file="$(dump_minio)"
      verify_readable "$pg_file"
      verify_readable "$minio_file"
      ship_offsite "$pg_file" "$minio_file"
      prune_old
      log "backup complete"
      ;;
    restore-test)
      restore_test "${2:-}"
      ;;
    *)
      die "usage: $0 [backup|restore-test [dump-file]]"
      ;;
  esac
}

main "$@"
