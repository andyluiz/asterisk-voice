# Asterisk Hermes Companion

Local-only Node service that bridges Asterisk ARI/ExternalMedia RTP (G.711 μ-law) to OpenAI Realtime.

## Architecture

This is **only the companion service**. Asterisk PBX runs separately (Docker, bare metal, or managed service). The companion connects via:

- ARI HTTP: `ARI_URL` (default `http://asterisk:8088/ari`)
- ARI WebSocket: `ARI_WS_URL` (default `ws://asterisk:8088/ari/events`)
- ExternalMedia RTP: binds to `RUNTIME_HOST` (auto-detected container IP)

The Asterisk side needs:
- `ari.conf` with a user matching `ARI_USERNAME` / `ARI_PASSWORD`
- `extensions.conf` with a Stasis app named `ARI_APP` (default `openclaw`)
- `pjsip.conf` with endpoints in `ALLOWED_EXTENSIONS`
- RTP range matching `rtp.conf`

## Safety boundary

- Binds on the host network but exposes no Docker ports.
- Every API route except `/health` requires `Authorization: Bearer $COMPANION_TOKEN`.
- `/v1/calls/prepare` never dials.
- `/v1/calls/{id}/start` rejects any request without `{"approved": true}`.
- Only extensions in `ALLOWED_EXTENSIONS` are accepted; trunk/PSTN endpoints are rejected.

## Configuration

All via environment variables (`.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `ARI_URL` | `http://asterisk:8088/ari` | Asterisk ARI base URL |
| `ARI_WS_URL` | `ws://asterisk:8088/ari/events` | ARI WebSocket |
| `ARI_USERNAME` | `openclaw` | ARI username |
| `ARI_PASSWORD` | *(required)* | ARI password |
| `ARI_APP` | `openclaw` | Stasis app name |
| `DEFAULT_CONTEXT` | `internal` | Asterisk dialplan context |
| `OPENAI_API_KEY` | *(required)* | OpenAI API key |
| `REALTIME_MODEL` | `gpt-realtime-2` | Realtime model |
| `REALTIME_VOICE` | `marin` | Realtime voice |
| `REALTIME_VAD_SILENCE_MS` | `450` | VAD silence threshold |
| `REALTIME_INSTRUCTIONS` | *(see realtime.js)* | Session instructions |
| `INBOUND_TRUSTED_CALLERS` | *(empty)* | Comma-separated caller IDs permitted to enter Hermes Voice; IDs are normalized before comparison |
| `INBOUND_HERMES_VOICE_CONTEXT` | *(concise pt-BR preference)* | Curated context exposed only to trusted inbound callers |
| `ALLOWED_EXTENSIONS` | `1001,1002,600,700,9000` | Allowed dial targets |
| `DIALPLAN_EXTENSIONS` | `600,700,9000` | Dialplan (Local/...) targets |
| `COMPANION_TOKEN` | *(required)* | Bearer token for companion API |
| `DEBUG_RECORD_CALLS` | `true` | Record WAV + JSON + journal |
| `CALL_JOURNAL_DIR` | `/recordings/call-events` | Journal output dir |

## Quick start

```bash
# 1. Ensure Asterisk is running with ARI + the extensions you need
# 2. Copy and edit config
cp .env.example .env
# Fill in ARI_PASSWORD, OPENAI_API_KEY, COMPANION_TOKEN, etc.

# 3. Build and run
docker compose up -d --build

# 4. Health check
curl -H "Authorization: Bearer $COMPANION_TOKEN" http://localhost:8091/health
```

## Inbound Hermes Voice admission

The `700` dialplan extension enters `Stasis(openclaw,inbound-realtime)` **without**
`Answer()`. On Stasis, the Companion writes a durable `pending_admission` record,
emits an authenticated `call.inbound.admission_requested` event, and leaves the
caller ringing. It does not invoke ARI answer, create ExternalMedia/a bridge, open
OpenAI Realtime, or send a greeting until an explicit authenticated decision.

Use the local MCP tools `pending_inbound_admissions` then
`decide_inbound_admission(call_id, decision)` (`answer`, `decline`, or
`leave_ringing`), or the equivalent authenticated HTTP API:

- `GET /v1/inbound-admissions`
- `POST /v1/calls/:id/admission` with `{"decision":"answer"}`

An admission deadline (`INBOUND_ADMISSION_TIMEOUT_MS`, default 30 seconds) is a
safe no-answer result: it journals `timed_out` and leaves the phone ringing until
the caller ends it. There is intentionally no fallback greeting or hangup.

Configure trusted identities as `E.164|known-label|relation` in
`INBOUND_TRUSTED_CALLERS`. The voice prompt receives only server-authored label,
relation, opaque session ID, and start time, plus curated voice context—never the
raw number, ARI channel ID, or caller-provided SIP display name. Trusted callers
use the narrow `request_hermes` handoff for substantive/current/private/tool-backed
requests; unknown callers stay in the no-tools `inbound_restricted` mode.

Configure `INBOUND_HERMES_WEBHOOK_ROUTES` as a JSON route table keyed by normalized
local caller extension. Each enabled route must name a non-`default` profile, a
loopback-only webhook URL, and a distinct secret environment variable. There is no
fallback: unlisted callers do not notify any profile. The supplied template maps
`1001 → hal` and carries disabled placeholders for `1002 → nova` and `1003 → kairo`;
keep those disabled until their own ports and secrets exist. The Companion POSTs
only the opaque admission request plus server-selected `callerProfile` routing
metadata using Hermes generic HMAC V2 (`X-Webhook-Timestamp` plus
`X-Webhook-Signature-V2`) and a stable `X-Request-ID`. It retries transient/HTTP
failures with that same idempotency key; a notification failure never answers,
hangs up, or otherwise changes the ringing call. Hermes receives the deadline in
the payload and must use `decide_inbound_admission`; only `answer` begins Voice.

## Deploy as a reusable service

This repo is designed to be forked/cloned by other Hermes users. They provide their own Asterisk; the companion is the portable piece.

```yaml
# In their docker-compose.yml (external to this repo)
services:
  asterisk-hermes-companion:
    image: ghcr.io/andyluiz/asterisk-voice/companion:latest  # or build from fork
    environment:
      ARI_URL: http://their-asterisk:8088/ari
      ARI_WS_URL: ws://their-asterisk:8088/ari/events
      ARI_USERNAME: their-user
      ARI_PASSWORD: ${ASTERISK_ARI_PASSWORD}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      COMPANION_TOKEN: ${COMPANION_TOKEN}
      # ...other vars
    volumes:
      - ./recordings:/recordings
```

## Tests

```bash
docker compose run --rm companion npm test
# or locally: npm test --prefix companion
```