# Asterisk Hermes companion

Local-only Node service that bridges Asterisk ARI/ExternalMedia RTP (G.711 μ-law) to OpenAI Realtime.

## Safety boundary

- Binds on the host network but exposes no Docker ports.
- Every API route except `/health` requires `Authorization: Bearer $COMPANION_TOKEN`.
- `/v1/calls/prepare` never dials.
- `/v1/calls/{id}/start` rejects any request without `{"approved": true}`.
- Only extensions in `ALLOWED_EXTENSIONS` are accepted; trunk/PSTN endpoints are rejected.

The companion is operated by the `asterisk-hermes` stdio MCP facade in `../mcp/`.
