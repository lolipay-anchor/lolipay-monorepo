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
REPO_DIR="${BACKUP_REPO_DIR:-/home/lolipay/lolipay-monorepo/ops/backup}"

INSTALLED_PAIRS=(
  "lolipay-backup.sh:/usr/local/sbin/lolipay-backup.sh"
  "lolipay-backup-failed.sh:/usr/local/sbin/lolipay-backup-failed.sh"
  "lolipay-backup.service:/etc/systemd/system/lolipay-backup.service"
  "lolipay-backup-verify.service:/etc/systemd/system/lolipay-backup-verify.service"
  "lolipay-backup-failed@.service:/etc/systemd/system/lolipay-backup-failed@.service"
  "lolipay-backup.timer:/etc/systemd/system/lolipay-backup.timer"
  "lolipay-backup-verify.timer:/etc/systemd/system/lolipay-backup-verify.timer"
)

SECRETS_ENV="home/lolipay/lolipay-monorepo/services/coordinator/.env"
SECRETS_KEYSTORE="home/lolipay/.config/stellar/identity"
SECRETS_ETC="etc/lolipay"
SECRETS_EXCLUDE="etc/lolipay/backup.key"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_TAG="lolipay-backup"

log()  { printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$LOG_TAG" "$*" >&2; }
die()  { printf '%s [%s] FATAL %s\n' "$(date -u +%FT%TZ)" "$LOG_TAG" "$*" >&2; exit 1; }

drift_fix_hint() {
  printf 'cd %s && sudo install -o root -g root -m 755 lolipay-backup.sh lolipay-backup-failed.sh /usr/local/sbin/ && sudo install -o root -g root -m 644 lolipay-backup.service lolipay-backup-verify.service lolipay-backup-failed@.service lolipay-backup.timer lolipay-backup-verify.timer /etc/systemd/system/ && sudo systemctl daemon-reload' "$REPO_DIR"
}

root_owned_unwritable() {
  local p="$1" owner mode
  owner="$(stat -c '%U' "$p" 2>/dev/null)" || { printf 'cannot be stat-ed, so this check is blind'; return 1; }
  mode="$(stat -c '%a' "$p" 2>/dev/null)" || { printf 'cannot be stat-ed, so this check is blind'; return 1; }
  [ "$owner" = "root" ] || { printf 'is owned by %s, not root' "$owner"; return 1; }
  [ $(( 8#$mode & 8#022 )) -eq 0 ] || { printf 'has mode %s, which lets group or other write it' "$mode"; return 1; }
}

drift_report() {
  local pair name installed repo why dir drifted=0
  for pair in "${INSTALLED_PAIRS[@]}"; do
    name="${pair%%:*}"
    installed="${pair#*:}"
    repo="$REPO_DIR/$name"
    dir="$(dirname "$installed")"
    if [ ! -f "$repo" ]; then
      log "DRIFT $name: no repository copy at $repo, so this comparison is BLIND; that is not the same as clean"
      drifted=1
    elif [ ! -f "$installed" ]; then
      log "DRIFT $name: nothing is installed at $installed"
      drifted=1
    elif ! why="$(root_owned_unwritable "$installed")"; then
      log "DRIFT $name: $installed $why, and root executes it"
      drifted=1
    elif ! why="$(root_owned_unwritable "$dir")"; then
      log "DRIFT $name: its directory $dir $why, so the file root executes can be replaced wholesale"
      drifted=1
    elif ! cmp -s "$repo" "$installed"; then
      log "DRIFT $name: $installed differs from $repo"
      drifted=1
    fi
  done
  if [ "$drifted" -ne 0 ]; then
    return 1
  fi
  log "installed copies match the repository, are root-owned and are writable by nobody else (${#INSTALLED_PAIRS[@]} artifacts compared)"
}

resolve_container() {
  local service="$1" explicit="$2" ids
  if [ -n "$explicit" ]; then printf '%s' "$explicit"; return 0; fi
  ids="$(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps -q "$service" 2>/dev/null || true)"
  printf '%s' "${ids%%$'\n'*}"
}

require_running() {
  local name="$1" label="$2"
  [ -n "$name" ] || die "cannot resolve the $label container; set ${label^^}_CONTAINER explicitly"
  local state
  state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo unknown)"
  [ "$state" = "running" ] || die "$label container ($name) is $state; refusing to back up against a container that is not running"
}

preflight() {
  command -v docker >/dev/null || die "docker not found on PATH"
  command -v gpg >/dev/null || die "gpg not found on PATH; without it every leg fails as if the dump itself had failed"
  docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon; this script needs root or docker-group access"

  [ -f "$PASSPHRASE_FILE" ] || die "passphrase file $PASSPHRASE_FILE does not exist; create it with mode 600 before backing up"
  local mode
  mode="$(stat -c '%a' "$PASSPHRASE_FILE")"
  local owner
  owner="$(stat -c '%U' "$PASSPHRASE_FILE")"
  [ "$owner" = "root" ] || die "passphrase file $PASSPHRASE_FILE is owned by $owner, not root"
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
    rm -f "$tmp" "$BACKUP_DIR/pg-$STAMP.dump.gpg"
    die "minio archive failed; the postgres dump for this stamp was removed so no half-pair is left behind"
  fi
  [ -s "$tmp" ] || { rm -f "$tmp"; die "minio archive produced an empty file"; }
  mv "$tmp" "$out"
  log "minio archive written: $out ($(du -h "$out" | cut -f1))"
  printf '%s' "$out"
}

dump_secrets() {
  local out="$BACKUP_DIR/secrets-$STAMP.tar.gpg"
  local tmp="$out.partial"
  log "archiving secrets: coordinator environment, stellar keystore, $SECRETS_ETC without $SECRETS_EXCLUDE"
  if ! tar -C / --exclude="$SECRETS_EXCLUDE" -cf - \
         "$SECRETS_ENV" "$SECRETS_KEYSTORE" "$SECRETS_ETC" | encrypt_to "$tmp"; then
    rm -f "$tmp"
    die "secrets archive failed; the postgres and minio artifacts for this stamp were kept AND ALREADY VERIFIED, because a database plus its object store still restores to an arbitrable trade; only the environment has to be rebuilt by hand"
  fi
  [ -s "$tmp" ] || { rm -f "$tmp"; die "secrets archive produced an empty file"; }
  mv "$tmp" "$out"
  log "secrets archive written: $out ($(du -h "$out" | cut -f1))"
  printf '%s' "$out"
}

verify_readable() {
  local f="$1"
  gpg --batch --quiet --pinentry-mode loopback \
      --passphrase-file "$PASSPHRASE_FILE" \
      --decrypt "$f" >/dev/null 2>&1 \
    || die "cannot decrypt $f with the configured passphrase; treating this run as failed"
  case "$(basename "$f")" in
    minio-*)
      local entries
      entries="$(gpg --batch --quiet --pinentry-mode loopback \
                   --passphrase-file "$PASSPHRASE_FILE" --decrypt "$f" 2>/dev/null \
                 | tar -tf - 2>/dev/null | wc -l)"
      [ "$entries" -ge 2 ] \
        || die "$f decrypts but holds $entries tar entries; an archive of nothing is not a backup"
      log "verified decryptable and a real archive ($entries entries): $(basename "$f")"
      ;;
    secrets-*)
      local members env_present keystore_live keystore_archived
      members="$(gpg --batch --quiet --pinentry-mode loopback \
                   --passphrase-file "$PASSPHRASE_FILE" --decrypt "$f" 2>/dev/null \
                 | tar -tf - 2>/dev/null)"
      if printf '%s\n' "$members" | grep -qxF "$SECRETS_EXCLUDE"; then
        die "$f CONTAINS $SECRETS_EXCLUDE, which is the passphrase every one of these archives is encrypted with; carrying it inside one is the same as shipping them all in plaintext"
      fi
      env_present="$(printf '%s\n' "$members" | grep -cxF "$SECRETS_ENV" || true)"
      if [ "$env_present" != "1" ]; then
        die "$f does not carry $SECRETS_ENV; without it the coordinator cannot boot from this backup"
      fi
      keystore_live="$(ls -1 "/$SECRETS_KEYSTORE"/*.toml 2>/dev/null | wc -l)"
      keystore_archived="$(printf '%s\n' "$members" | grep -F "$SECRETS_KEYSTORE/" | grep -c '\.toml$' || true)"
      if [ "$keystore_live" -lt 1 ]; then
        die "the live keystore /$SECRETS_KEYSTORE holds no identity files; refusing to call this archive verified against nothing"
      fi
      if [ "$keystore_archived" != "$keystore_live" ]; then
        die "$f holds $keystore_archived keystore identities but the live keystore has $keystore_live"
      fi
      log "verified decryptable: $(printf '%s\n' "$members" | wc -l) members, coordinator environment present, $keystore_archived of $keystore_live keystore identities, $SECRETS_EXCLUDE absent: $(basename "$f")"
      ;;
    *)
      log "verified decryptable end to end: $(basename "$f")"
      ;;
  esac
}

ship_offsite() {
  [ -n "$OFFSITE_CMD" ] || { log "WARNING no BACKUP_OFFSITE_CMD configured — these copies live on the same disk as the data they protect, which is not a backup"; return 0; }
  log "shipping off-site"
  local f
  for f in "$@"; do
    BACKUP_FILE="$f" bash -c "$OFFSITE_CMD" || die "off-site command failed for $f"
  done
  log "off-site copies confirmed"
}

prune_old() {
  log "pruning backups older than $RETENTION_DAYS days"
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.gpg' -mtime "+$RETENTION_DAYS" -print -delete
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.partial' -mmin +120 -print -delete
}

restore_test() {
  local dump="${1:-}"
  [ -n "$dump" ] || dump="$(ls -1t "$BACKUP_DIR"/pg-*.dump.gpg 2>/dev/null | head -1)"
  [ -n "$dump" ] || die "no postgres dump found to restore-test"
  [ -f "$dump" ] || die "$dump does not exist"

  local stamp="${dump##*/pg-}"; stamp="${stamp%%.dump.gpg}"
  [ -f "$BACKUP_DIR/minio-$stamp.tar.gpg" ] \
    || die "no minio archive for $stamp; half a backup restores to an unarbitrable trade"

  local scratch="lolipay_restore_test_$$"
  local started
  started="$(date +%s)"
  log "restore test starting: $dump -> database $scratch"

  docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $scratch;" >/dev/null
  docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE $scratch;" >/dev/null

  if ! gpg --batch --quiet --pinentry-mode loopback \
        --passphrase-file "$PASSPHRASE_FILE" --decrypt "$dump" \
      | docker exec -i "$PG_NAME" pg_restore -U "$PG_USER" -d "$scratch" --no-owner --no-privileges --exit-on-error; then
    docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $scratch;" >/dev/null || true
    die "pg_restore failed; this backup is NOT usable"
  fi

  local tables live configs
  tables="$(docker exec "$PG_NAME" psql -U "$PG_USER" -d "$scratch" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
  live="$(docker exec "$PG_NAME" psql -U "$PG_USER" -d "$PG_DB" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
  configs="$(docker exec "$PG_NAME" psql -U "$PG_USER" -d "$scratch" -tAc \
    'SELECT count(*) FROM "Config";' 2>/dev/null || echo 0)"

  local elapsed=$(( $(date +%s) - started ))
  if [ "$tables" != "$live" ]; then
    docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $scratch;" >/dev/null || true
    die "restore produced $tables tables but the live schema has $live; this backup is NOT usable"
  fi
  if [ "$configs" -lt 1 ]; then
    docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $scratch;" >/dev/null || true
    die "restore produced $tables tables but no Config row; the schema came back and the data did not"
  fi
  docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $scratch;" >/dev/null
  log "restore test PASSED: $tables tables matching live, data present, in ${elapsed}s (measured RTO for the database leg)"
}

main() {
  preflight
  PG_NAME="$(resolve_container postgres "$PG_CONTAINER")"
  MINIO_NAME="$(resolve_container minio "$MINIO_CONTAINER")"
  require_running "$PG_NAME" pg
  require_running "$MINIO_NAME" minio

  case "${1:-backup}" in
    backup)
      local pg_file minio_file secrets_file
      drift_report || log "WARNING the repository and the installed copies disagree. THIS RUN USED THE INSTALLED COPY, and it is going ahead: a stale backup is worth far more than no backup. Reinstall with: $(drift_fix_hint)"
      pg_file="$(dump_postgres)"
      minio_file="$(dump_minio)"
      verify_readable "$pg_file"
      verify_readable "$minio_file"
      secrets_file="$(dump_secrets)"
      verify_readable "$secrets_file"
      ship_offsite "$pg_file" "$minio_file" "$secrets_file"
      prune_old
      log "backup complete"
      ;;
    restore-test)
      restore_test "${2:-}"
      drift_report || die "the restore above proves the INSTALLED copy works, and the installed copy is not what the repository says it should be, so this week's proof describes code that is not the source of truth. Reinstall with: $(drift_fix_hint)"
      ;;
    *)
      die "usage: $0 [backup|restore-test [dump-file]]"
      ;;
  esac
}

main "$@"
