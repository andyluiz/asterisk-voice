# Project Instructions: Asterisk Voice

## Project Overview

This directory is the baseline snapshot for the OpenClaw `asterisk-voice` plugin.
It is intentionally LAN-only and currently verified with Zoiper dialing extension
`700` to reach Hal through Asterisk/OpenClaw Realtime.

## Architecture & Structure

- `src/index.js`: OpenClaw plugin entrypoint. It owns ARI REST/WebSocket handling,
  RTP ExternalMedia packet handling, and Realtime bridge setup through OpenClaw.
- `asterisk/etc/`: PBX config for ARI, PJSIP endpoints, RTP, and dialplan.
- `docker-compose.yml`: Runs only the Asterisk container. The Node plugin runs
  inside the OpenClaw Gateway, not in a separate companion/runtime container.
- `openclaw/`: Sanitized baseline config for the plugin entry.
- `.local-backups/`: Full local config backups; ignored by git because they may
  contain secrets.

## Current Known-Good Baseline

- Asterisk uses `network_mode: host`.
- ARI HTTP binds to `127.0.0.1:8088`.
- OpenClaw plugin config uses `externalMediaHost: "127.0.0.1"`.
- Extension `1001` is Anderson's SIP endpoint.
- Extension `700` is the inbound Hal call path.

## Workflow Guidelines

- After changing `asterisk/etc/` or `docker-compose.yml`, restart/recreate the
  Asterisk container.
- After changing `src/index.js` or OpenClaw plugin config, restart the OpenClaw
  Gateway.
- Validate with:

```bash
node --check src/index.js
openclaw config validate
openclaw gateway call asteriskvoice.health --json
```

Then test a live Zoiper call to `700`.
