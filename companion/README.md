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
| `REALTIME_MODEL` | `gpt-realtime` | Realtime model |
| `REALTIME_VOICE` | `ash` | Realtime voice |
| `REALTIME_VAD_SILENCE_MS` | `450` | VAD silence threshold |
| `REALTIME_INSTRUCTIONS` | *(see realtime.js)* | Session instructions |
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