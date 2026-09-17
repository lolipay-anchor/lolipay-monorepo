#!/usr/bin/env bash
set -uo pipefail

UNIT="${1:-lolipay-backup.service}"
ENV_FILE="${COORDINATOR_ENV:-/home/lolipay/lolipay-monorepo/services/coordinator/.env}"
LOG_TAG=lolipay-backup-failed

log() { printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$LOG_TAG" "$*" >&2; }

detail="$(journalctl -u "$UNIT" -n 12 --no-pager 2>/dev/null | tail -6 || true)"
log "$UNIT FAILED"
log "$detail"

webhook=""
if [ -r "$ENV_FILE" ]; then
  webhook="$(awk -F= '/^ALERT_WEBHOOK_URL=/{sub(/^[^=]*=/,""); print; exit}' "$ENV_FILE")"
fi

if [ -z "$webhook" ]; then
  log "ALERT_WEBHOOK_URL is empty or unreadable in $ENV_FILE, so this failure reaches the journal and nobody else; exiting non-zero so that an alert nobody receives is itself a failed unit"
  exit 1
fi

case "$webhook" in
  *[\"\']*)
    log "ALERT_WEBHOOK_URL is quoted in $ENV_FILE; the quotes are part of the value this handler read, so it is not a URL anything can post to. Exiting non-zero rather than reporting a delivery that cannot happen"
    exit 1
    ;;
esac

text="🔴 lolipay: $UNIT failed on $(hostname). The backup that protects the arbitration record did not complete. Last lines: $(printf '%s' "$detail" | tr '\n' ' ' | cut -c1-800)"
payload="$(printf '{"text":%s,"content":%s}' "$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" "$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"

if curl -fsS -m 15 -X POST -H 'content-type: application/json' -d "$payload" "$webhook" >/dev/null 2>&1; then
  log "failure reported to the alert webhook"
else
  status=$?
  log "could not reach the alert webhook, curl exited $status; exiting non-zero so this undelivered alert shows in systemctl --failed instead of only in a journal nobody is reading"
  exit 1
fi
