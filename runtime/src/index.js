import express from 'express';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import os from 'node:os';

// Auto-detect container IP: use the first non-loopback IPv4 address
function detectContainerIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '172.17.0.2';
}

const config = {
  port: Number(process.env.PORT ?? 8091),
  ariUrl: process.env.ARI_URL ?? 'http://asterisk:8088/ari',
  ariWsUrl: process.env.ARI_WS_URL ?? 'ws://asterisk:8088/ari/events',
  ariUsername: process.env.ARI_USERNAME ?? 'openclaw',
  ariPassword: process.env.ARI_PASSWORD ?? 'openclaw-local-change-me',
  ariApp: process.env.ARI_APP ?? 'openclaw',
  defaultContext: process.env.DEFAULT_CONTEXT ?? 'internal',
  testPromptSound: process.env.TEST_PROMPT_SOUND ?? 'custom/openclaw-test-prompt',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
  transcriptionModel: process.env.TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe',
  realtimeModel: process.env.REALTIME_MODEL ?? 'gpt-realtime-2',
  realtimeVoice: process.env.REALTIME_VOICE ?? 'alloy',
  realtimeInstructions: process.env.REALTIME_INSTRUCTIONS
    ?? 'Voce e Hal, assistente do Anderson. Responda em portugues do Brasil, de forma curta e natural.',
  realtimeGreeting: process.env.REALTIME_GREETING ?? 'Oi Anderson, aqui e o Hal. Pode falar.',
  runtimeHost: process.env.RUNTIME_HOST || detectContainerIp(),
};

const app = express();
app.use(express.json({ limit: '64kb' }));

const calls = new Map();
const channelToCallId = new Map();
const sseClients = new Set();

let ariWs = null;
let ariWsConnected = false;
let reconnectTimer = null;

function authHeader() {
  return `Basic ${Buffer.from(`${config.ariUsername}:${config.ariPassword}`).toString('base64')}`;
}

function ariRestUrl(path) {
  return new URL(path.replace(/^\/+/, ''), `${config.ariUrl.replace(/\/+$/, '')}/`).toString();
}

async function ariRequest(path, options = {}) {
  const response = await fetch(ariRestUrl(path), {
    ...options,
    headers: {
      Authorization: authHeader(),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const error = new Error(`ARI ${options.method ?? 'GET'} ${path} failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function ariBinaryRequest(path, options = {}) {
  const response = await fetch(ariRestUrl(path), {
    ...options,
    headers: {
      Authorization: authHeader(),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = new Error(`ARI ${options.method ?? 'GET'} ${path} failed: ${response.status}`);
    error.status = response.status;
    error.body = await response.text();
    throw error;
  }

  return {
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    data: Buffer.from(await response.arrayBuffer()),
  };
}

async function checkAriInfo() {
  try {
    const info = await ariRequest('/asterisk/info');
    return { ok: true, system: info?.system ?? null };
  } catch (error) {
    return { ok: false, status: error.status ?? null, error: error.message };
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRtpPacket(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12) return null;
  const version = packet[0] >> 6;
  if (version !== 2) return null;
  const hasExtension = Boolean(packet[0] & 0x10);
  const csrcCount = packet[0] & 0x0f;
  let offset = 12 + csrcCount * 4;
  if (packet.length < offset) return null;
  if (hasExtension) {
    if (packet.length < offset + 4) return null;
    const extensionLengthWords = packet.readUInt16BE(offset + 2);
    offset += 4 + extensionLengthWords * 4;
    if (packet.length < offset) return null;
  }
  return {
    marker: Boolean(packet[1] & 0x80),
    payloadType: packet[1] & 0x7f,
    sequenceNumber: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    payload: packet.subarray(offset),
  };
}

function buildRtpPacket({ payload, sequenceNumber, timestamp, ssrc, payloadType = 0, marker = false }) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f);
  header.writeUInt16BE(sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

function resolveEndpoint({ endpoint, to }) {
  const target = endpoint ?? to;
  if (!target || typeof target !== 'string') {
    throw Object.assign(new Error('Provide endpoint or to'), { status: 400 });
  }

  if (target.startsWith('PJSIP/') || target.startsWith('Local/')) {
    return target;
  }

  if (/^local:/i.test(target)) {
    const extension = target.slice(target.indexOf(':') + 1).trim();
    if (!extension) {
      throw Object.assign(new Error('Local target must include an extension'), { status: 400 });
    }
    return `Local/${extension}@${config.defaultContext}`;
  }

  if (/^\d+$/.test(target)) {
    return `PJSIP/${target}`;
  }

  throw Object.assign(new Error('Unsupported endpoint format'), { status: 400 });
}

function publicCall(call) {
  const {
    ws,
    realtimeCleanup,
    ...safeCall
  } = call;
  return safeCall;
}

function sendSse(client, event) {
  client.write(`event: ${event.type}\n`);
  client.write(`data: ${JSON.stringify(event)}\n\n`);
}

function emitCallEvent(type, callId, data = {}) {
  const event = {
    type,
    callId,
    at: nowIso(),
    ...data,
  };

  const call = calls.get(callId);
  if (call) {
    call.updatedAt = event.at;
    call.events.push(event);
  }

  for (const client of sseClients) {
    sendSse(client, event);
  }
}

async function playTestPrompt(channelId) {
  const playbackId = `prompt-${randomUUID()}`;
  const params = new URLSearchParams({
    media: `sound:${config.testPromptSound}`,
  });
  await ariRequest(`/channels/${encodeURIComponent(channelId)}/play/${encodeURIComponent(playbackId)}?${params}`, {
    method: 'POST',
  });
  return playbackId;
}

async function startRecording(channelId, recordingName) {
  const params = new URLSearchParams({
    name: recordingName,
    format: 'wav',
    maxDurationSeconds: '45',
    maxSilenceSeconds: '0',
    ifExists: 'overwrite',
    beep: 'false',
    terminateOn: 'none',
  });
  await ariRequest(`/channels/${encodeURIComponent(channelId)}/record?${params}`, {
    method: 'POST',
  });
}

async function transcribeRecording(recordingName) {
  if (!config.openaiApiKey) {
    throw Object.assign(new Error('OPENAI_API_KEY is not configured in the asterisk-voice runtime'), {
      status: 503,
    });
  }

  let recording = null;
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      recording = await ariBinaryRequest(`/recordings/stored/${encodeURIComponent(recordingName)}/file`);
      break;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  if (!recording) throw lastError;

  const form = new FormData();
  form.append('model', config.transcriptionModel);
  form.append('file', new Blob([recording.data], { type: recording.contentType }), `${recordingName}.wav`);

  const response = await fetch(`${config.openaiBaseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: form,
  });

  const body = await response.json().catch(async () => ({ error: await response.text() }));
  if (!response.ok) {
    const error = new Error(`Transcription failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body.text ?? '';
}

async function runPromptRecordTest(call, channelId) {
  if (call.promptRecordStarted) return;
  call.promptRecordStarted = true;
  call.recordingName = `openclaw-answer-${call.id}`;

  try {
    emitCallEvent('call.prompt.playing', call.id, { channelId, sound: config.testPromptSound });
    await playTestPrompt(channelId);
    await sleep(1200);
    await startRecording(channelId, call.recordingName);
    call.status = 'recording';
    emitCallEvent('call.recording.started', call.id, {
      channelId,
      recordingName: call.recordingName,
      maxDurationSeconds: 45,
    });
  } catch (error) {
    call.status = 'error';
    emitCallEvent('call.error', call.id, { channelId, error: error.message });
  }
}

async function finalizePromptRecordTest(call) {
  if (call.mode !== 'prompt-record' || call.transcriptionStarted || !call.recordingName) return;
  call.transcriptionStarted = true;

  try {
    emitCallEvent('call.transcription.started', call.id, { recordingName: call.recordingName });
    const transcript = await transcribeRecording(call.recordingName);
    call.transcript = transcript;
    emitCallEvent('call.transcribed', call.id, {
      recordingName: call.recordingName,
      transcript,
    });
  } catch (error) {
    emitCallEvent('call.transcription.error', call.id, {
      recordingName: call.recordingName,
      error: error.message,
      details: error.body ?? null,
    });
  }
}

function findCallByChannel(channelId) {
  if (!channelId) return null;
  const mapped = channelToCallId.get(channelId);
  if (mapped) return calls.get(mapped) ?? null;

  for (const call of calls.values()) {
    if (call.channelId === channelId) return call;
  }
  return null;
}

function callStatusForState(state) {
  if (state === 'Ringing') return 'ringing';
  if (state === 'Up') return 'answered';
  return null;
}

function normalizeAriEvent(event) {
  const channel = event.channel ?? event.channel_snapshot ?? null;
  const channelId = channel?.id ?? event.channel_id ?? null;
  const call = findCallByChannel(channelId);
  const channelName = channel?.name ?? '';
  const isExternalMediaChannel = channelName.startsWith('UnicastRTP/');

  if (event.type === 'StasisStart') {
    const stasisMode = event.args?.[0] ?? null;
    const isInboundRealtime = stasisMode === 'inbound-realtime';
    const callId = isInboundRealtime
      ? (event.args?.[1] || call?.id || `inbound-${channelId || randomUUID()}`)
      : (event.args?.[0] || call?.id || channelId || randomUUID());
    let stored = calls.get(callId);
    if (!stored) {
      stored = {
        id: callId,
        mode: isInboundRealtime ? 'realtime' : undefined,
        direction: isInboundRealtime ? 'inbound' : undefined,
        endpoint: channel?.name ?? null,
        requestedTo: isInboundRealtime ? 'openclaw' : null,
        from: channel?.caller?.number ?? channel?.caller?.name ?? null,
        channelId,
        status: 'started',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        events: [],
      };
      calls.set(callId, stored);
    }
    if (channelId) {
      if (isExternalMediaChannel) {
        stored.externalChannelId = channelId;
      } else {
        stored.channelId = channelId;
        stored.primaryChannelId = channelId;
      }
    }
    stored.status = stored.status === 'created' ? 'started' : stored.status;
    if (channelId) channelToCallId.set(channelId, callId);
    emitCallEvent('call.active', callId, { channelId, rawType: event.type });
    if (stored.mode === 'prompt-record' && channelId) {
      runPromptRecordTest(stored, channelId);
    }
    if (stored.mode === 'realtime' && channelId && !stored.bridgeStarted) {
      stored.bridgeStarted = true;
      stored.primaryChannelId = channelId;
      // Answer the channel first so it's in a bridgeable state
      ariRequest(`/channels/${encodeURIComponent(channelId)}/answer`, { method: 'POST' })
        .catch(() => {}) // answer may fail if already answered; that's fine
        .finally(() => {
          startRealtimeBridge(stored, channelId).catch((err) => {
            stored.bridgeStarted = false; // allow retry on explicit re-call only
            console.error('[realtime] bridge start failed:', err.message);
            emitCallEvent('call.error', stored.id, { error: err.message });
          });
        });
    }
    return;
  }

  if (event.type === 'RecordingFinished') {
    const recordingName = event.recording?.name ?? null;
    const recordedCall = recordingName
      ? [...calls.values()].find((candidate) => candidate.recordingName === recordingName)
      : call;
    if (!recordedCall) return;
    recordedCall.status = 'recorded';
    emitCallEvent('call.recording.finished', recordedCall.id, {
      channelId,
      recordingName,
      rawType: event.type,
    });
    finalizePromptRecordTest(recordedCall);
    if (recordedCall.channelId && recordedCall.status !== 'ended') {
      ariRequest(`/channels/${encodeURIComponent(recordedCall.channelId)}`, { method: 'DELETE' }).catch(() => {});
    }
    return;
  }

  if (!call) return;
  const callId = call.id;

  if (event.type === 'ChannelStateChange') {
    const status = callStatusForState(channel?.state);
    if (status) call.status = status;
    emitCallEvent(status ? `call.${status}` : 'call.state', callId, {
      channelId,
      state: channel?.state ?? null,
      rawType: event.type,
    });
    return;
  }

  if (event.type === 'ChannelDtmfReceived') {
    emitCallEvent('call.dtmf', callId, {
      channelId,
      digit: event.digit,
      durationMs: event.duration_ms ?? null,
      rawType: event.type,
    });
    return;
  }

  if (event.type === 'StasisEnd') {
    if (call.mode === 'realtime' && typeof call.realtimeCleanup === 'function' && !call.realtimeCleanupStarted) {
      call.realtimeCleanup('stasis-end').catch((error) => {
        console.error('[realtime] cleanup after StasisEnd failed:', error.message);
      });
      return;
    }
    call.status = 'ended';
    emitCallEvent('call.ended', callId, { channelId, rawType: event.type });
    finalizePromptRecordTest(call);
    return;
  }

  if (event.type === 'ChannelDestroyed' || event.type === 'ChannelHangupRequest') {
    if (call.mode === 'realtime' && typeof call.realtimeCleanup === 'function' && !call.realtimeCleanupStarted) {
      call.realtimeCleanup(event.type).catch((error) => {
        console.error(`[realtime] cleanup after ${event.type} failed:`, error.message);
      });
      return;
    }
    call.status = 'ended';
    emitCallEvent('call.ended', callId, {
      channelId,
      cause: event.cause ?? null,
      causeTxt: event.cause_txt ?? null,
      rawType: event.type,
    });
    finalizePromptRecordTest(call);
  }
}

// ---------------------------------------------------------------------------
// Real-time bridge: UDP ↔ WebSocket
// ---------------------------------------------------------------------------

function realtimeWsUrl() {
  const base = config.openaiBaseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
  const url = new URL('/v1/realtime', `${base}/`);
  url.searchParams.set('model', config.realtimeModel);
  return url.toString();
}

function openRealtimeWebSocket() {
  if (!config.openaiApiKey) {
    throw Object.assign(new Error('OPENAI_API_KEY is not configured in the asterisk-voice runtime'), {
      status: 503,
    });
  }
  return new WebSocket(realtimeWsUrl(), {
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
  });
}

function buildRealtimeSessionUpdate() {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: config.realtimeModel,
      output_modalities: ['audio'],
      instructions: config.realtimeInstructions,
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          transcription: { model: config.transcriptionModel },
          turn_detection: {
            type: 'server_vad',
            create_response: true,
            interrupt_response: true,
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
          },
        },
        output: {
          format: { type: 'audio/pcmu' },
          voice: config.realtimeVoice,
        },
      },
    },
  };
}

function buildGreetingResponse() {
  return {
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
      instructions: config.realtimeGreeting,
    },
  };
}

function readRealtimeAudioDelta(event) {
  return event.delta
    ?? event.audio
    ?? event.item?.content?.delta
    ?? event.response?.audio?.delta
    ?? null;
}

function readRealtimeTranscript(event) {
  return event.transcript
    ?? event.text
    ?? event.delta
    ?? event.item?.content?.transcript
    ?? null;
}

async function startRealtimeBridge(call, channelId) {
  const callId = call.id;
  console.log(`[realtime] starting bridge for call ${callId} channel ${channelId}`);

  // 1. Create UDP socket, bind to 0.0.0.0:0 (dynamic port)
  const udpSocket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    udpSocket.once('error', reject);
    udpSocket.bind(0, '0.0.0.0', () => {
      udpSocket.removeListener('error', reject);
      resolve();
    });
  });
  const udpPort = udpSocket.address().port;
  console.log(`[realtime] UDP socket bound on port ${udpPort}`);

  let asteriskRemoteAddress = null;
  let asteriskRemotePort = null;
  let externalChannelId = null;
  let bridgeId = null;
  let wsClient = null;
  let chunkCounter = 0;
  let inboundRtpPackets = 0;
  let inboundAudioBytes = 0;
  let outboundRtpPackets = 0;
  let outboundAudioBytes = 0;
  let outboundSequenceNumber = Math.floor(Math.random() * 0xffff);
  let outboundTimestamp = Math.floor(Math.random() * 0xffffffff) >>> 0;
  let outboundSsrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
  let outboundPayloadType = 0;
  let cleaned = false;

  function rememberAsteriskSource(rinfo, inboundRtp) {
    if (!asteriskRemoteAddress) {
      asteriskRemoteAddress = rinfo.address;
      asteriskRemotePort = rinfo.port;
      if (inboundRtp) {
        outboundPayloadType = inboundRtp.payloadType;
        outboundTimestamp = (inboundRtp.timestamp + 160) >>> 0;
      }
      console.log(`[realtime] Asterisk ExternalMedia source: ${asteriskRemoteAddress}:${asteriskRemotePort} payloadType=${outboundPayloadType}`);
    }
  }

  function sendAudioToAsterisk(muLaw) {
    if (!asteriskRemoteAddress || !asteriskRemotePort) return;
    const hadOutbound = outboundRtpPackets > 0;
    for (let offset = 0; offset < muLaw.length; offset += 160) {
      const payload = muLaw.subarray(offset, Math.min(offset + 160, muLaw.length));
      if (payload.length === 0) continue;
      const packet = buildRtpPacket({
        payload,
        sequenceNumber: outboundSequenceNumber,
        timestamp: outboundTimestamp,
        ssrc: outboundSsrc,
        payloadType: outboundPayloadType,
      });
      udpSocket.send(packet, asteriskRemotePort, asteriskRemoteAddress);
      outboundSequenceNumber = (outboundSequenceNumber + 1) & 0xffff;
      outboundTimestamp = (outboundTimestamp + payload.length) >>> 0;
      outboundRtpPackets += 1;
      outboundAudioBytes += payload.length;
    }
    if (!hadOutbound && outboundRtpPackets > 0) {
      console.log(`[realtime] first outbound RTP sent packets=${outboundRtpPackets} audioBytes=${outboundAudioBytes}`);
    }
  }

  async function cleanup(reason) {
    if (cleaned) return;
    cleaned = true;
    call.realtimeCleanupStarted = true;
    console.log(`[realtime] cleanup: ${reason}`);
    try { udpSocket.close(); } catch {}
    try {
      if (wsClient && wsClient.readyState === WebSocket.OPEN) wsClient.close();
    } catch {}
    // Hang up both the primary SIP leg and the ExternalMedia RTP leg.
    const cleanupChannelIds = [...new Set([
      call.primaryChannelId,
      call.channelId,
      channelId,
      call.externalChannelId,
      externalChannelId,
    ].filter(Boolean))];
    for (const cleanupChannelId of cleanupChannelIds) {
      try {
        await ariRequest(`/channels/${encodeURIComponent(cleanupChannelId)}`, { method: 'DELETE' });
      } catch {}
    }
    // Destroy bridge
    try {
      if (bridgeId) {
        await ariRequest(`/bridges/${encodeURIComponent(bridgeId)}`, { method: 'DELETE' });
      }
    } catch {}
    call.realtimeStats = {
      inboundRtpPackets,
      inboundAudioBytes,
      outboundRtpPackets,
      outboundAudioBytes,
    };
    call.status = 'ended';
    emitCallEvent('call.ended', callId, {
      channelId,
      reason,
      realtimeStats: call.realtimeStats,
    });
  }

  try {
    // 2. Call Asterisk ExternalMedia API
    const externalHost = `${config.runtimeHost}:${udpPort}`;
    console.log(`[realtime] creating ExternalMedia channel, external_host=${externalHost}`);
    const extMediaBody = {
      app: config.ariApp,
      external_host: externalHost,
      format: 'ulaw',
      data: callId,
    };
    const extMedia = await ariRequest('/channels/externalMedia', {
      method: 'POST',
      body: JSON.stringify(extMediaBody),
    });
    externalChannelId = extMedia?.id;
    if (!externalChannelId) throw new Error('ExternalMedia did not return a channel id');
    console.log(`[realtime] ExternalMedia channel id=${externalChannelId}`);
    call.externalChannelId = externalChannelId;
    channelToCallId.set(externalChannelId, callId);

    // 3. Create mixing bridge and add both channels
    const bridge = await ariRequest('/bridges', {
      method: 'POST',
      body: JSON.stringify({ type: 'mixing', name: `bridge-${callId}` }),
    });
    bridgeId = bridge?.id;
    if (!bridgeId) throw new Error('Bridge creation did not return an id');
    console.log(`[realtime] bridge id=${bridgeId}`);

    // Add channels one at a time (multi-channel addChannel is unreliable)
    await ariRequest(`/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
      method: 'POST',
      body: JSON.stringify({ channel: channelId }),
    });
    await ariRequest(`/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
      method: 'POST',
      body: JSON.stringify({ channel: externalChannelId }),
    });
    console.log(`[realtime] both channels added to bridge`);

    // 4. Connect directly to OpenAI Realtime. No voice-call plugin or webhook is needed.
    const wsUrl = realtimeWsUrl();
    console.log(`[realtime] connecting directly to OpenAI Realtime url=${wsUrl}`);
    call.status = 'bridging';
    emitCallEvent('call.realtime.bridging', callId, { channelId, externalChannelId, bridgeId, wsUrl });

    // 5. Connect WebSocket to OpenAI Realtime
    wsClient = openRealtimeWebSocket();
    call.ws = wsClient;
    call.realtimeCleanup = cleanup;

    wsClient.on('open', () => {
      console.log(`[realtime] WS connected to OpenAI`);
      wsClient.send(JSON.stringify(buildRealtimeSessionUpdate()));
      if (config.realtimeGreeting) {
        wsClient.send(JSON.stringify(buildGreetingResponse()));
      }
      emitCallEvent('call.realtime.started', callId, { model: config.realtimeModel });
    });

    // 7a. WS -> UDP (OpenAI audio -> Asterisk ExternalMedia)
    wsClient.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const audioDelta = readRealtimeAudioDelta(msg);
        if ((msg.type === 'response.audio.delta' || msg.type === 'response.output_audio.delta' || audioDelta) && audioDelta) {
          const buf = Buffer.from(audioDelta, 'base64');
          sendAudioToAsterisk(buf);
        } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          const transcript = readRealtimeTranscript(msg);
          if (transcript) {
            call.transcript = [call.transcript, transcript].filter(Boolean).join('\n');
            emitCallEvent('call.transcribed', callId, { transcript, isFinal: true });
          }
        } else if (msg.type === 'response.audio_transcript.done' || msg.type === 'response.output_text.done') {
          const text = readRealtimeTranscript(msg);
          if (text) emitCallEvent('call.speaking', callId, { text });
        } else if (msg.type === 'input_audio_buffer.speech_started') {
          emitCallEvent('call.speech.started', callId, { channelId });
        } else if (msg.type === 'input_audio_buffer.speech_stopped') {
          emitCallEvent('call.speech.stopped', callId, { channelId });
        } else if (msg.type === 'error') {
          const detail = msg.error?.message ?? msg.error?.type ?? 'OpenAI realtime error';
          console.error('[realtime] OpenAI error:', detail);
          emitCallEvent('call.error', callId, { error: detail, details: msg.error ?? null });
        }
      } catch (err) {
        console.error('[realtime] WS message parse error:', err.message);
      }
    });

    wsClient.on('close', (code) => {
      console.log(`[realtime] WS closed code=${code}`);
      cleanup('ws-close').catch(() => {});
    });

    wsClient.on('error', (err) => {
      console.error('[realtime] WS error:', err.message);
      cleanup('ws-error').catch(() => {});
    });

    // 7b. UDP -> WS (Asterisk audio -> OpenAI)
    udpSocket.on('message', (buf, rinfo) => {
      const rtp = parseRtpPacket(buf);
      if (!rtp || rtp.payload.length === 0) return;
      rememberAsteriskSource(rinfo, rtp);
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        chunkCounter += 1;
        inboundRtpPackets += 1;
        inboundAudioBytes += rtp.payload.length;
        wsClient.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: rtp.payload.toString('base64'),
        }));
      }
    });

    udpSocket.on('error', (err) => {
      console.error('[realtime] UDP error:', err.message);
      cleanup('udp-error').catch(() => {});
    });

    udpSocket.on('close', () => {
      cleanup('udp-close').catch(() => {});
    });

  } catch (err) {
    await cleanup(`init-error: ${err.message}`);
    throw err;
  }

  // Hook into StasisEnd for main channel to trigger cleanup
  // (handled in normalizeAriEvent StasisEnd → call.status = 'ended' → emitCallEvent triggers below)
  // We listen for the call.ended event via the existing emitCallEvent path — but we also
  // attach a one-shot listener directly here for safety.
  const origEmit = emitCallEvent;
  // We can't easily monkey-patch emitCallEvent, so we rely on the StasisEnd handler
  // which sets call.status = 'ended'. Poll check is not needed — cleanup() is idempotent.
  // The udpSocket/ws errors will also trigger cleanup if Asterisk drops the channel.
}

// ---------------------------------------------------------------------------

function wsUrlWithAuth() {
  const url = new URL(config.ariWsUrl);
  url.searchParams.set('api_key', `${config.ariUsername}:${config.ariPassword}`);
  url.searchParams.set('app', config.ariApp);
  return url.toString();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectAriWebSocket();
  }, 2000);
}

function connectAriWebSocket() {
  if (ariWs && (ariWs.readyState === WebSocket.OPEN || ariWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ariWs = new WebSocket(wsUrlWithAuth());

  ariWs.on('open', () => {
    ariWsConnected = true;
  });

  ariWs.on('message', (message) => {
    try {
      normalizeAriEvent(JSON.parse(message.toString()));
    } catch (error) {
      console.error('Failed to process ARI event:', error.message);
    }
  });

  ariWs.on('close', () => {
    ariWsConnected = false;
    scheduleReconnect();
  });

  ariWs.on('error', (error) => {
    ariWsConnected = false;
    console.error('ARI WebSocket error:', error.message);
  });
}

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    ari: await checkAriInfo(),
    wsConnected: ariWsConnected,
    knownCallCount: calls.size,
  });
});

app.post('/calls', async (req, res, next) => {
  try {
    const callId = req.body?.callId || randomUUID();
    const endpoint = resolveEndpoint(req.body ?? {});
    const call = {
      id: callId,
      endpoint,
      requestedTo: req.body?.to ?? null,
      channelId: null,
      status: 'created',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      events: [],
    };
    calls.set(callId, call);

    const originateParams = new URLSearchParams({
      endpoint,
      app: config.ariApp,
      appArgs: callId,
      channelId: callId,
    });
    const originate = await ariRequest(`/channels/originate?${originateParams}`, {
      method: 'POST',
    });

    if (originate?.id) {
      call.channelId = originate.id;
      channelToCallId.set(originate.id, callId);
    }
    call.status = 'originating';
    emitCallEvent('call.initiated', callId, { endpoint, channelId: call.channelId });

    res.status(201).json(publicCall(call));
  } catch (error) {
    next(error);
  }
});

app.post('/calls/realtime', async (req, res, next) => {
  try {
    const callId = req.body?.callId || randomUUID();
    const endpoint = resolveEndpoint(req.body ?? { to: '1001' });
    const call = {
      id: callId,
      mode: 'realtime',
      endpoint,
      requestedTo: req.body?.to ?? '1001',
      channelId: null,
      status: 'created',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      events: [],
    };
    calls.set(callId, call);

    const originateParams = new URLSearchParams({
      endpoint,
      app: config.ariApp,
      appArgs: callId,
      channelId: callId,
    });
    const originate = await ariRequest(`/channels/originate?${originateParams}`, {
      method: 'POST',
    });

    if (originate?.id) {
      call.channelId = originate.id;
      channelToCallId.set(originate.id, callId);
    }
    call.status = 'originating';
    emitCallEvent('call.initiated', callId, { endpoint, channelId: call.channelId, mode: 'realtime' });

    res.status(201).json(publicCall(call));
  } catch (error) {
    next(error);
  }
});

app.post('/tests/prompt-record', async (req, res, next) => {
  try {
    const callId = req.body?.callId || randomUUID();
    const endpoint = resolveEndpoint(req.body ?? { to: '1001' });
    const call = {
      id: callId,
      mode: 'prompt-record',
      endpoint,
      requestedTo: req.body?.to ?? null,
      channelId: null,
      status: 'created',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      events: [],
    };
    calls.set(callId, call);

    const originateParams = new URLSearchParams({
      endpoint,
      app: config.ariApp,
      appArgs: callId,
      channelId: callId,
    });
    const originate = await ariRequest(`/channels/originate?${originateParams}`, {
      method: 'POST',
    });

    if (originate?.id) {
      call.channelId = originate.id;
      channelToCallId.set(originate.id, callId);
    }
    call.status = 'originating';
    emitCallEvent('call.initiated', callId, { endpoint, channelId: call.channelId });

    res.status(201).json(publicCall(call));
  } catch (error) {
    next(error);
  }
});

app.get('/calls/:id', (req, res) => {
  const call = calls.get(req.params.id);
  if (!call) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  res.json(publicCall(call));
});

app.delete('/calls/:id', async (req, res, next) => {
  try {
    const call = calls.get(req.params.id);
    if (!call) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }

    if (typeof call.realtimeCleanup === 'function') {
      await call.realtimeCleanup('api-delete');
    } else if (call.status !== 'ended') {
      const channelIds = [...new Set([call.primaryChannelId, call.channelId, call.externalChannelId].filter(Boolean))];
      for (const channelId of channelIds) {
        try {
          await ariRequest(`/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
    }

    call.status = 'ended';
    emitCallEvent('call.ended', call.id, { channelId: call.channelId, requestedBy: 'api' });
    res.json(publicCall(call));
  } catch (error) {
    next(error);
  }
});

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache, no-transform',
  });
  res.write('\n');

  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.use((error, req, res, next) => {
  const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
  res.status(status).json({
    error: error.message,
    ...(error.body ? { details: error.body } : {}),
  });
});

connectAriWebSocket();

app.listen(config.port, () => {
  console.log(`Asterisk OpenClaw runtime listening on :${config.port}`);
});
