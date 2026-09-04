# Asterisk Voice Companion

Standalone Node service that bridges Asterisk ARI/ExternalMedia RTP (G.711 μ-law) to OpenAI Realtime.

This repository contains **only the companion service**. Asterisk PBX is external infrastructure.

## Quick start

```bash
# 1. Have a running Asterisk with ARI enabled (see companion/README.md)
# 2. Configure
cp .env.example .env
# Edit .env with your Asterisk ARI credentials, OpenAI key, etc.

# 3. Build and run companion
docker compose up -d --build

# 4. Verify
curl -H "Authorization: Bearer $COMPANION_TOKEN" http://localhost:8091/health
```

## Structure

```
├── companion/           # The companion service (Docker image, source, tests)
│   ├── src/
│   │   ├── index.js      # Core: ARI/Stasis/RTP/Realtime bridge
│   │   ├── policy.js     # Allowlist, brief normalization, pizza authority
│   │   ├── realtime.js   # Session/prompt helpers (testable)
│   │   └── realtime_state.js  # Deterministic response/session/language state
│   ├── test/             # 12 deterministic tests
│   ├── scripts/          # Realtime smoke tests
│   ├── Dockerfile
│   └── package.json
├── mcp/                  # HTTP client/server + call watcher for Hermes integration
├── docker-compose.yml    # Runs companion only (Asterisk is external)
├── .env.example          # Template for all required env vars
└── scripts/smoke-test.sh # End-to-end test script
```

## For Hermes users

This repo is designed to be consumed as a reusable component. Other Hermes users can:

1. Run their own Asterisk (any way they prefer)
2. Deploy this companion pointing at their Asterisk via env vars
3. Integrate via the MCP interface (`mcp/client.py`, `mcp/server.py`)

See `companion/README.md` for full configuration reference and deployment guide.

## Tests

```bash
docker compose run --rm companion npm test
# or locally: npm test --prefix companion
```