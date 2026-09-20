# Realtime Voice Bridge

## Goal

`asterisk-voice` is self-contained for Asterisk calls. It does not require the OpenClaw `voice-call` plugin or a separate companion service.

## Endpoint

```bash
curl -H 'Content-Type: application/json' \
  -d '{"to":"1001"}' \
  http://127.0.0.1:8091/calls/realtime
```

## Architecture

```text
Inbound phone or SIP extension
  -> Asterisk PJSIP channel
  -> ARI Stasis(openclaw,inbound-realtime)
  -> Asterisk ExternalMedia RTP
  -> asterisk-voice runtime UDP socket
  -> OpenAI Realtime websocket
  -> Hermes handoff HTTP endpoint (only for higher-function requests)
```

## Flow

1. An inbound route enters `Stasis(openclaw,inbound-realtime)`; outbound calls use the authenticated `/v1/calls` prepare/start flow.
2. On `StasisStart`, the runtime answers the channel, marks it as Hermes Voice mode, and creates an ExternalMedia channel with `format=ulaw`.
3. A mixing bridge connects the SIP channel and ExternalMedia channel.
4. Incoming Asterisk RTP is stripped to mu-law payloads and sent as `input_audio_buffer.append` to OpenAI Realtime.
5. OpenAI `response.audio.delta` mu-law audio is packetized back into RTP and sent to Asterisk.
6. Ordinary conversation stays in Realtime. `request_hermes` sends a bounded, authenticated text request to `HERMES_URL` and returns its validated `say` result to Realtime.
7. Hangup, websocket close, UDP error, Hermes cancellation, or API delete cleans up the channels, bridge, socket, and call record.

## Config

- `OPENAI_API_KEY`: required for realtime calls.
- `REALTIME_MODEL`: defaults to `gpt-realtime-2`.
- `REALTIME_VOICE`: defaults to `alloy`.
- `REALTIME_INSTRUCTIONS`: system behavior for the voice session.
- `REALTIME_GREETING`: optional first spoken response when the websocket opens.
- `INBOUND_GREETING`: greeting spoken on inbound calls after the Realtime session is ready.
- `HERMES_URL` / `HERMES_TOKEN`: authenticated higher-function handoff endpoint and token.
- `RUNTIME_HOST`: IP that Asterisk uses for ExternalMedia RTP. Defaults to autodetected container IP.

## Local API

- `GET /health`
- `POST /v1/calls/prepare`
- `POST /v1/calls/:id/start`
- `POST /tests/prompt-record`
- `GET /calls/:id`
- `DELETE /calls/:id`
- `GET /events`

## Events

- `call.initiated`
- `call.ringing`
- `call.answered`
- `call.active`
- `call.realtime.bridging`
- `call.realtime.started`
- `call.transcribed`
- `call.speaking`
- `call.error`
- `call.ended`
