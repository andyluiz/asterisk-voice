# Asterisk Voice Plugin

LAN-only Asterisk voice plugin for OpenClaw experiments. It owns ARI call control, SIP/PJSIP endpoints, RTP ExternalMedia, and OpenClaw Realtime audio bridging.

## Services

- `asterisk`: local PBX with ARI, PJSIP extension `1001`, optional test extension `1002`, and Stasis app `openclaw`.
- `asterisk-voice`: OpenClaw plugin loaded by the Gateway from `src/index.js`.

## Quick Start

```bash
cd /path/to/asterisk-voice
cp .env.example .env
cp asterisk/etc/ari.conf.example asterisk/etc/ari.conf
cp asterisk/etc/pjsip.conf.example asterisk/etc/pjsip.conf
# Fill the local placeholders before starting.
docker compose up -d
```

## LAN Softphone

Register a SIP softphone against this host using the local credentials configured in `asterisk/etc/pjsip.conf`. Do not commit that file; the repository provides `pjsip.conf.example` only.

To call Hal directly from the softphone, dial extension `700`.

## OpenClaw Gateway API

```bash
openclaw gateway call asteriskvoice.health --json

openclaw gateway call asteriskvoice.start \
  --json \
  --params '{"to":"1001"}'

openclaw gateway call asteriskvoice.end \
  --json \
  --params '{"callId":"<call-id>"}'
```

The plugin does not require the old OpenClaw `voice-call` plugin. Realtime sessions go through the OpenClaw Realtime voice provider layer.

## Baseline

- Current plugin source/config snapshot lives in this directory.
- Sanitized OpenClaw plugin config baseline lives under `openclaw/`.
- Full local config backups live under `.local-backups/` and are intentionally ignored by git because they may contain secrets.

## Safety

This is intentionally local/LAN-only. Do not add CheapConnect/PSTN until outbound confirmation, allowlists, spend caps, and destination blocking are implemented.
