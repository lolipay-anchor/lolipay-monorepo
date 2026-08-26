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
  log "ALERT_WEBHOOK_URL is unset, so this failure reaches the journal and nobody else"
  exit 0
fi

text="🔴 lolipay: $UNIT failed on $(hostname). The backup that protects the arbitration record did not complete. Last lines: $(printf '%s' "$detail" | tr '\n' ' ' | cut -c1-800)"
payload="$(printf '{"text":%s,"content":%s}' "$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" "$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"

if curl -fsS -m 15 -X POST -H 'content-type: application/json' -d "$payload" "$webhook" >/dev/null 2>&1; then
  log "failure reported to the alert webhook"
else
  log "could not reach the alert webhook; the failure is in the journal only"
fi
