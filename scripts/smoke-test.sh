#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARI_USER="${ARI_USER:-openclaw}"
ARI_PASSWORD="${ARI_PASSWORD:-openclaw-local-change-me}"
RUNTIME_URL="${RUNTIME_URL:-${COMPANION_URL:-http://127.0.0.1:8091}}"
ARI_URL="${ARI_URL:-http://127.0.0.1:8088/ari}"

cd "$ROOT_DIR"

echo "== docker compose config =="
docker compose config >/dev/null

echo "== containers =="
docker compose ps

echo "== wait for ARI REST =="
for attempt in {1..30}; do
  if curl -fsS -u "$ARI_USER:$ARI_PASSWORD" "$ARI_URL/asterisk/info" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "ARI did not become ready in time" >&2
    exit 1
  fi
  sleep 1
done

echo "== wait for runtime =="
for attempt in {1..30}; do
  if curl -fsS "$RUNTIME_URL/health" | jq -e '.ari.ok == true and .wsConnected == true' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "Runtime/ARI WebSocket did not become ready in time" >&2
    exit 1
  fi
  sleep 1
done

echo "== ARI REST =="
curl -fsS -u "$ARI_USER:$ARI_PASSWORD" "$ARI_URL/asterisk/info" | jq . >/dev/null

echo "== runtime health =="
curl -fsS "$RUNTIME_URL/health" | jq .

echo "== Asterisk PJSIP endpoints =="
docker compose exec -T asterisk asterisk -rx "pjsip show endpoints"

echo "== local Stasis originate smoke =="
CALL_ID="smoke-$(date +%s)"
curl -fsS \
  -H "Content-Type: application/json" \
  -d "{\"callId\":\"$CALL_ID\",\"endpoint\":\"Local/9000@internal\"}" \
  "$RUNTIME_URL/calls" | jq .

sleep 2

echo "== stored call =="
curl -fsS "$RUNTIME_URL/calls/$CALL_ID" | jq .

echo "== hangup/cleanup =="
curl -fsS -X DELETE "$RUNTIME_URL/calls/$CALL_ID" | jq .

echo "Smoke test complete."
