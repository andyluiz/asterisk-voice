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
Phone or SIP extension
  -> Asterisk PJSIP channel
  -> ARI Stasis(openclaw)
  -> Asterisk ExternalMedia RTP
  -> asterisk-voice runtime UDP socket
  -> OpenAI Realtime websocket
```

## Flow

1. `POST /calls/realtime` originates a SIP call through ARI.
2. On `StasisStart`, the runtime answers the channel and creates an ExternalMedia channel with `format=ulaw`.
3. A mixing bridge connects the SIP channel and ExternalMedia channel.
4. Incoming Asterisk RTP is stripped to mu-law payloads and sent as `input_audio_buffer.append` to OpenAI Realtime.
5. OpenAI `response.audio.delta` mu-law audio is packetized back into RTP and sent to Asterisk.
6. Hangup, websocket close, UDP error, or API delete cleans up the channels, bridge, socket, and call record.

## Config

- `OPENAI_API_KEY`: required for realtime calls.
- `REALTIME_MODEL`: defaults to `gpt-realtime-2`.
- `REALTIME_VOICE`: defaults to `alloy`.
- `REALTIME_INSTRUCTIONS`: system behavior for the voice session.
- `REALTIME_GREETING`: optional first spoken response when the websocket opens.
- `RUNTIME_HOST`: IP that Asterisk uses for ExternalMedia RTP. Defaults to autodetected container IP.

## Local API

- `GET /health`
- `POST /calls`
- `POST /calls/realtime`
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
