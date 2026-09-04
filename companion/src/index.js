import express from 'express';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import os from 'node:os';
import { appendFileSync, chownSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createPreparedCall, requireApprovedStart, validateLocalEndpoint } from './policy.js';
import {
  DEFAULT_REALTIME_INTRODUCTION,
  DEFAULT_REALTIME_VOICE,
  buildRealtimeSessionUpdate,
  detectCallLanguage,
} from './realtime.js';
import {
  acknowledgeConversationItemCreated,
  acknowledgeSessionUpdated,
  beginLanguageSync,
  buildLanguageSyncItem,
  completeLanguageSyncIfReady,
  createRealtimeResponseState,
  markOutputAudioStarted,
  markResponseDone,
  requestResponse,
} from './realtime_state.js';

// Auto-detect container IP: use the first non-loopback IPv4 address
function decodeMuLaw(byte) {
  const value = (~byte) & 0xff;
  const magnitude = (((value & 0x0f) << 3) + 0x84) << ((value >> 4) & 0x07);
  return (value & 0x80) ? 0x84 - magnitude : magnitude - 0x84;
}

function encodeMuLaw(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  let magnitude = Math.min(32635, Math.abs(Math.round(sample))) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); exponent -= 1, mask >>= 1) {}
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function fadeMuLawFrame(frame, direction, samples = 40) {
  const output = Buffer.from(frame);
  const count = Math.min(samples, output.length);
  for (let i = 0; i < count; i += 1) {
    const index = direction === 'in' ? i : output.length - count + i;
    const gain = direction === 'in' ? (i + 1) / count : (count - i - 1) / count;
    output[index] = encodeMuLaw(decodeMuLaw(output[index]) * gain);
  }
  return output;
}

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
  realtimeVoice: process.env.REALTIME_VOICE ?? DEFAULT_REALTIME_VOICE,
  realtimeVadSilenceMs: Number(process.env.REALTIME_VAD_SILENCE_MS ?? '450'),
  realtimeInstructions: process.env.REALTIME_INSTRUCTIONS
    ?? 'You are Hal, Anderson\'s digital assistant. Speak naturally, briefly, and directly in the call language.',
  realtimeGreeting: process.env.REALTIME_GREETING ?? 'Hello Anderson, this is Hal. How can I help?',
  realtimeIntroduction: process.env.REALTIME_INTRODUCTION ?? DEFAULT_REALTIME_INTRODUCTION,
  runtimeHost: process.env.RUNTIME_HOST || detectContainerIp(),
  companionToken: process.env.COMPANION_TOKEN ?? '',
  debugRecordCalls: String(process.env.DEBUG_RECORD_CALLS ?? 'false').toLowerCase() === 'true',
  callJournalDir: process.env.CALL_JOURNAL_DIR ?? '/recordings/call-events',
  callJournalUid: Number(process.env.CALL_JOURNAL_UID ?? '1000'),
  allowedExtensions: new Set((process.env.ALLOWED_EXTENSIONS ?? '1001,1002,600,700,9000')
    .split(',').map((value) => value.trim()).filter(Boolean)),
  dialplanExtensions: new Set((process.env.DIALPLAN_EXTENSIONS ?? '600,700,9000')
    .split(',').map((value) => value.trim()).filter(Boolean)),
};

const app = express();
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!config.companionToken) {
    return res.status(503).json({ error: 'COMPANION_TOKEN is not configured' });
  }
  const presented = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (presented !== config.companionToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
});

const calls = new Map();
const channelToCallId = new Map();
const debugRecordingWaiters = new Map();
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

async function originatePreparedCall(call) {
  const originateParams = new URLSearchParams({
    endpoint: call.endpoint,
    app: config.ariApp,
    appArgs: call.id,
    channelId: call.id,
  });
  const originate = await ariRequest(`/channels/originate?${originateParams}`, { method: 'POST' });
  if (originate?.id) {
    call.channelId = originate.id;
    channelToCallId.set(originate.id, call.id);
  }
  call.status = 'originating';
  emitCallEvent('call.initiated', call.id, {
    endpoint: call.endpoint,
    channelId: call.channelId,
    mode: 'realtime',
  });
  return call;
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
  try {
    return validateLocalEndpoint(endpoint ?? to, config.allowedExtensions, config.dialplanExtensions);
  } catch (error) {
    throw Object.assign(error, { status: 400 });
  }
}

function publicCall(call) {
  const { ws, realtimeCleanup, ...safeCall } = call;
  if (safeCall.pendingDecision) {
    const { timer, resolve, ...safeDecision } = safeCall.pendingDecision;
    safeCall.pendingDecision = safeDecision;
  }
  safeCall.events = safeCall.events.map((event) => {
    if (!event.decision) return event;
    const { timer, resolve, ...safeDecision } = event.decision;
    return { ...event, decision: safeDecision };
  });
  return safeCall;
}

function createPendingDecision(call, request) {
  if (call.pendingDecision) throw new Error('A decision is already pending for this call');
  const decision = {
    id: randomUUID(),
    kind: String(request.kind ?? '').slice(0, 64),
    candidate: request.candidate && typeof request.candidate === 'object' ? request.candidate : {},
    question: String(request.question ?? '').trim().slice(0, 1000),
    requestedAt: nowIso(),
    deadlineAt: new Date(Date.now() + 20_000).toISOString(),
    status: 'pending',
  };
  if (!decision.question) throw new Error('A decision question is required');
  call.pendingDecision = decision;
  emitCallEvent('call.decision.requested', call.id, { decision });
  return decision;
}

function resolvePendingDecision(call, decision, response) {
  if (!call.pendingDecision || call.pendingDecision.id !== decision.id || decision.status !== 'pending') {
    throw new Error('Decision is no longer pending');
  }
  const allowed = new Set(['accept', 'decline', 'counteroffer', 'callback']);
  if (!allowed.has(response.decision)) throw new Error('Decision must be accept, decline, counteroffer, or callback');
  decision.status = 'resolved';
  decision.resolvedAt = nowIso();
  decision.response = { decision: response.decision, say: String(response.say ?? '').trim().slice(0, 1000) };
  call.pendingDecision = null;
  emitCallEvent('call.decision.resolved', call.id, { decisionId: decision.id, response: decision.response });
  decision.resolve?.(decision.response);
}

function journalPath(callId) {
  return path.join(config.callJournalDir, `${callId}.jsonl`);
}

function journalRecord(record) {
  try {
    mkdirSync(config.callJournalDir, { recursive: true });
    const target = journalPath(record.callId ?? record.call?.id);
    appendFileSync(target, `${JSON.stringify(record, (key, value) => (
      key === 'timer' || key === 'resolve' ? undefined : value
    ))}\n`, { encoding: 'utf8', mode: 0o600 });
    chownSync(target, config.callJournalUid, config.callJournalUid);
  } catch (error) {
    console.error('[journal] write failed:', error.message);
  }
}

function journalCallSnapshot(call) {
  journalRecord({ type: 'call.snapshot', callId: call.id, at: nowIso(), call: {
    id: call.id, endpoint: call.endpoint, requestedTo: call.requestedTo, purpose: call.purpose,
    brief: call.brief, status: call.status, createdAt: call.createdAt, updatedAt: call.updatedAt,
  } });
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

  journalRecord(event);
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

async function startBridgeRecording(bridgeId, recordingName) {
  const params = new URLSearchParams({
    name: recordingName,
    format: 'wav',
    maxDurationSeconds: '7200',
    maxSilenceSeconds: '0',
    ifExists: 'overwrite',
    beep: 'false',
    terminateOn: 'none',
  });
  await ariRequest(`/bridges/${encodeURIComponent(bridgeId)}/record?${params}`, {
    method: 'POST',
  });
}

async function stopLiveRecording(recordingName) {
  // POST /stop finalizes a stored recording. DELETE would cancel and discard it.
  await ariRequest(`/recordings/live/${encodeURIComponent(recordingName)}/stop`, { method: 'POST' });
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
      ? [...calls.values()].find((candidate) => candidate.recordingName === recordingName || candidate.debugRecordingName === recordingName)
      : call;
    if (!recordedCall) return;
    const debugRecording = recordingName === recordedCall.debugRecordingName;
    emitCallEvent('call.recording.finished', recordedCall.id, {
      channelId,
      recordingName,
      rawType: event.type,
      scope: debugRecording ? 'mixed-call-audio' : 'prompt-record',
    });
    if (debugRecording) {
      const waiter = debugRecordingWaiters.get(recordingName);
      if (waiter) {
        debugRecordingWaiters.delete(recordingName);
        waiter();
      }
      return;
    }
    recordedCall.status = 'recorded';
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

function buildIntroductionResponse() {
  return { type: 'response.create', response: { output_modalities: ['audio'] } };
}

function buildConversationResponse() {
  return { type: 'response.create', response: { output_modalities: ['audio'] } };
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

export function calleeExplicitlyRequestedHangup(transcript) {
  const text = String(transcript || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
  return /\b(pode (encerrar|desligar|finalizar|concluir)|vamos (encerrar|desligar|finalizar)|desligue|pode fechar a ligacao|hang up|end (the )?call|you can (hang up|end the call)|tot ziens|hang op)\b/.test(text);
}

async function startRealtimeBridge(call, channelId) {
  const callId = call.id;
  call.activeLanguage = call.brief?.preferred_language || 'pt-BR';
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
  const responseState = createRealtimeResponseState();
  const queuedInboundAudioBeforeSession = [];
  let chunkCounter = 0;
  let inboundRtpPackets = 0;
  let inboundAudioBytes = 0;
  let outboundRtpPackets = 0;
  let outboundAudioBytes = 0;
  let outboundSilenceFrames = 0;
  let outboundFadeIns = 0;
  let lastSentWasSilence = true;
  let outboundSequenceNumber = Math.floor(Math.random() * 0xffff);
  let outboundTimestamp = Math.floor(Math.random() * 0xffffffff) >>> 0;
  let outboundSsrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
  let outboundPayloadType = 0;
  const rtpFrameBytes = 160; // G.711 μ-law at 8 kHz: exactly 20 ms per RTP packet.
  const rtpFrameMs = 20;
  const rtpSilenceFrame = Buffer.alloc(rtpFrameBytes, 0xff); // PCMU silence; keeps ExternalMedia clock continuous.
  let outboundAudioRemainder = Buffer.alloc(0);
  const outboundRtpQueue = [];
  let outboundRtpTimer = null;
  let nextRtpDueAt = null;
  let outboundLateFrames = 0;
  let outboundMaxPacingLatenessMs = 0;
  let deferredEnd = null;
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
      scheduleRtpPump();
    }
  }

  function scheduleRtpPump() {
    // ExternalMedia behaves best with a continuous 20 ms RTP clock. During model gaps
    // transmit PCMU silence instead of letting Asterisk underflow/PLC a discontinuity.
    if (cleaned || outboundRtpTimer || !asteriskRemoteAddress || !asteriskRemotePort) return;
    const now = performance.now();
    if (nextRtpDueAt == null) nextRtpDueAt = now;
    const delayMs = Math.max(0, nextRtpDueAt - now);
    outboundRtpTimer = setTimeout(() => {
      outboundRtpTimer = null;
      if (cleaned) return;
      const sentAt = performance.now();
      const latenessMs = Math.max(0, sentAt - nextRtpDueAt);
      outboundMaxPacingLatenessMs = Math.max(outboundMaxPacingLatenessMs, latenessMs);
      if (latenessMs > 5) outboundLateFrames += 1;
      let payload = outboundRtpQueue.shift() ?? rtpSilenceFrame;
      if (payload === rtpSilenceFrame) {
        outboundSilenceFrames += 1;
        lastSentWasSilence = true;
      } else {
        if (lastSentWasSilence) {
          payload = fadeMuLawFrame(payload, 'in');
          outboundFadeIns += 1;
        }
        lastSentWasSilence = false;
      }
      const packet = buildRtpPacket({
        payload,
        sequenceNumber: outboundSequenceNumber,
        timestamp: outboundTimestamp,
        ssrc: outboundSsrc,
        payloadType: outboundPayloadType,
      });
      udpSocket.send(packet, asteriskRemotePort, asteriskRemoteAddress, () => {
        maybeFinishDeferredEnd();
      });
      outboundSequenceNumber = (outboundSequenceNumber + 1) & 0xffff;
      outboundTimestamp = (outboundTimestamp + rtpFrameBytes) >>> 0;
      outboundRtpPackets += 1;
      outboundAudioBytes += payload.length;
      if (outboundRtpPackets === 1) {
        console.log(`[realtime] first paced outbound RTP sent packets=1 audioBytes=${outboundAudioBytes}`);
      }
      // Keep an absolute cadence rather than adding timer callback latency to every frame.
      nextRtpDueAt += rtpFrameMs;
      if (sentAt > nextRtpDueAt) nextRtpDueAt = sentAt + rtpFrameMs;
      scheduleRtpPump();
    }, delayMs);
  }

  function clearQueuedAudio(reason) {
    const discardedFrames = outboundRtpQueue.length;
    outboundRtpQueue.length = 0;
    outboundAudioRemainder = Buffer.alloc(0);
    if (discardedFrames > 0) {
      console.log(`[realtime] discarded ${discardedFrames} queued RTP frames: ${reason}`);
    }
  }

  function queueAudioToAsterisk(muLaw, flush = false) {
    if (!Buffer.isBuffer(muLaw)) return;
    if (muLaw.length > 0) {
      outboundAudioRemainder = Buffer.concat([outboundAudioRemainder, muLaw]);
    }
    while (outboundAudioRemainder.length >= rtpFrameBytes) {
      outboundRtpQueue.push(outboundAudioRemainder.subarray(0, rtpFrameBytes));
      outboundAudioRemainder = outboundAudioRemainder.subarray(rtpFrameBytes);
    }
    if (flush && outboundAudioRemainder.length > 0) {
      const padded = Buffer.alloc(rtpFrameBytes, 0xff); // μ-law silence
      outboundAudioRemainder.copy(padded);
      outboundRtpQueue.push(padded);
      outboundAudioRemainder = Buffer.alloc(0);
    }
    if (flush && outboundRtpQueue.length > 0) {
      const last = outboundRtpQueue.length - 1;
      outboundRtpQueue[last] = fadeMuLawFrame(outboundRtpQueue[last], 'out');
    }
    scheduleRtpPump();
  }

  function requestAudioResponse(response, reason) {
    return requestAudioResponseWithOptions(response, reason, { queueIfBlocked: false });
  }

  function sendQueuedResponse(request) {
    if (!request || !wsClient || wsClient.readyState !== WebSocket.OPEN) return false;
    call.activeResponseReason = request.reason;
    if (request.reason === 'decision-result') call.decisionResolving = true;
    wsClient.send(JSON.stringify(request.response));
    emitCallEvent('call.response.sent', callId, { reason: request.reason });
    return true;
  }

  function flushQueuedResponses(requests) {
    for (const request of requests) {
      if (sendQueuedResponse(request)) return true;
    }
    return false;
  }

  function requestAudioResponseWithOptions(response, reason, options) {
    if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
      emitCallEvent('call.response.skipped', callId, { reason, wsOpen: false });
      return false;
    }
    const outcome = requestResponse(responseState, response, reason, options);
    if (!outcome.sent) {
      emitCallEvent(outcome.queued ? 'call.response.queued' : 'call.response.skipped', callId, {
        reason,
        responseInFlight: responseState.responseInFlight,
        sessionConfigured: responseState.sessionConfigured,
        pendingLanguageSync: responseState.pendingLanguageSync?.language ?? null,
      });
      return false;
    }
    call.activeResponseReason = reason;
    if (reason === 'decision-result') call.decisionResolving = true;
    wsClient.send(JSON.stringify(outcome.payload.response));
    emitCallEvent('call.response.sent', callId, { reason });
    return true;
  }

  function maybeFinishDeferredEnd() {
    if (!deferredEnd || !deferredEnd.responseDone || deferredEnd.cleanupScheduled || cleaned) return;
    if (outboundRtpQueue.length > 0 || outboundAudioRemainder.length > 0) return;
    deferredEnd.cleanupScheduled = true;
    emitCallEvent('call.control.end_audio_drained', callId, { reason: deferredEnd.reason });
    // The last RTP packet was handed to the UDP socket. Leave one frame time for it to
    // reach Asterisk before tearing down the ExternalMedia channel.
    setTimeout(() => {
      cleanup(`realtime-end-call: ${deferredEnd.reason}`).catch((error) => {
        console.error('[realtime] deferred end_call cleanup failed:', error.message);
      });
    }, rtpFrameMs);
  }

  function armDeferredEnd(reason) {
    if (deferredEnd) return;
    deferredEnd = { reason, responseDone: false, cleanupScheduled: false };
    call.endCallPending = { reason, requestedAt: new Date().toISOString() };
    emitCallEvent('call.control.end_deferred', callId, { reason });
  }

  async function cleanup(reason) {
    if (cleaned) return;
    cleaned = true;
    call.realtimeCleanupStarted = true;
    console.log(`[realtime] cleanup: ${reason}`);
    if (outboundRtpTimer) clearTimeout(outboundRtpTimer);
    outboundRtpTimer = null;
    if (call.pendingDecision?.status === 'pending') {
      const decision = call.pendingDecision;
      clearTimeout(decision.timer);
      call.pendingDecision = null;
      decision.status = 'cancelled';
      decision.resolve?.({ decision: 'callback', say: 'Não foi possível concluir a confirmação agora.' });
      emitCallEvent('call.decision.cancelled', callId, { decisionId: decision.id, reason });
    }
    outboundRtpQueue.length = 0;
    outboundAudioRemainder = Buffer.alloc(0);
    try { udpSocket.close(); } catch {}
    try {
      if (wsClient && wsClient.readyState === WebSocket.OPEN) wsClient.close();
    } catch {}
    if (call.debugRecordingName && !call.debugRecordingStopped) {
      try {
        await stopLiveRecording(call.debugRecordingName);
        call.debugRecordingStopped = true;
        await Promise.race([
          call.debugRecordingFinished,
          sleep(3000),
        ]);
        emitCallEvent('call.recording.stopped', callId, {
          recordingName: call.debugRecordingName,
          recordingPath: call.debugRecordingPath,
          scope: 'mixed-call-audio',
        });
      } catch (error) {
        emitCallEvent('call.recording.error', callId, {
          recordingName: call.debugRecordingName,
          error: error.message,
        });
      }
    }
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
      outboundSilenceFrames,
      outboundFadeIns,
      pacing: {
        lateFramesOver5ms: outboundLateFrames,
        maxLatenessMs: Number(outboundMaxPacingLatenessMs.toFixed(3)),
      },
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
    if (config.debugRecordCalls) {
      call.debugRecordingName = `debug-call-${callId}`;
      call.debugRecordingFinished = new Promise((resolve) => {
        debugRecordingWaiters.set(call.debugRecordingName, resolve);
      });
      await startBridgeRecording(bridgeId, call.debugRecordingName);
      call.debugRecordingPath = `/home/anderson/apps/asterisk-voice/recordings/${call.debugRecordingName}.wav`;
      emitCallEvent('call.recording.started', callId, {
        recordingName: call.debugRecordingName,
        recordingPath: call.debugRecordingPath,
        scope: 'mixed-call-audio',
      });
    }

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
      console.log(`[realtime] WS connected; waiting for session.created before configuring session`);
      emitCallEvent('call.realtime.connected', callId, { model: config.realtimeModel });
    });

    // 7a. WS -> UDP (OpenAI audio -> Asterisk ExternalMedia)
    wsClient.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session.created') {
          wsClient.send(JSON.stringify(buildRealtimeSessionUpdate(call, config)));
          emitCallEvent('call.realtime.configuring', callId, { model: config.realtimeModel });
          return;
        }
        if (msg.type === 'session.updated') {
          const ack = acknowledgeSessionUpdated(responseState);
          if (ack.type === 'initial-session-configured') {
            for (const payload of queuedInboundAudioBeforeSession.splice(0)) {
              wsClient.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload.toString('base64') }));
            }
            emitCallEvent('call.realtime.started', callId, {
              model: config.realtimeModel,
              awaitingCalleeSpeech: true,
            });
          } else if (ack.type === 'language-session-updated') {
            emitCallEvent('call.language.session_updated', callId, { language: ack.language });
          }
          completeLanguageSyncIfReady(responseState);
          flushQueuedResponses(ack.flushed);
          return;
        }
        if (msg.type === 'conversation.item.created') {
          const itemAck = acknowledgeConversationItemCreated(responseState, msg.item?.id ?? null);
          if (itemAck.matched) {
            emitCallEvent('call.language.system_item_created', callId, { language: itemAck.language });
            completeLanguageSyncIfReady(responseState);
            flushQueuedResponses(itemAck.flushed);
          }
          return;
        }
        const audioDelta = readRealtimeAudioDelta(msg);
        if ((msg.type === 'response.audio.delta' || msg.type === 'response.output_audio.delta' || audioDelta) && audioDelta) {
          if (!responseState.outputAudioStarted) markOutputAudioStarted(responseState);
          const buf = Buffer.from(audioDelta, 'base64');
          queueAudioToAsterisk(buf);
        } else if (msg.type === 'response.audio.done' || msg.type === 'response.output_audio.done') {
          queueAudioToAsterisk(Buffer.alloc(0), true);
        } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          const transcript = readRealtimeTranscript(msg);
          if (transcript) {
            call.callerTranscript = [call.callerTranscript, transcript].filter(Boolean).join('\n');
            if (calleeExplicitlyRequestedHangup(transcript)) {
              call.calleeExplicitHangup = true;
              emitCallEvent('call.callee.hangup_authorized', callId, { transcript });
            }
            emitCallEvent('call.transcript.caller', callId, { transcript, isFinal: true });
            const detectedLanguage = call.brief?.adapt_language !== false && detectCallLanguage(transcript);
            if (detectedLanguage && detectedLanguage !== call.activeLanguage) {
              const previousLanguage = call.activeLanguage;
              call.activeLanguage = detectedLanguage;
              emitCallEvent('call.language.changed', callId, { from: previousLanguage, to: detectedLanguage });
              if (responseState.sessionConfigured && wsClient?.readyState === WebSocket.OPEN) {
                const languageSync = beginLanguageSync(responseState, detectedLanguage);
                wsClient.send(JSON.stringify(buildLanguageSyncItem(languageSync)));
                wsClient.send(JSON.stringify(buildRealtimeSessionUpdate(call, config, {
                  includeVoice: !responseState.outputAudioStarted,
                })));
                emitCallEvent('call.language.session_update_sent', callId, { language: detectedLanguage });
              }
            }
            if (wsClient?.readyState === WebSocket.OPEN) {
              if (!call.introductionSent) {
                call.introductionSent = true;
                emitCallEvent('call.introduction.started', callId, { afterCalleeSpeech: true });
                requestAudioResponseWithOptions(buildIntroductionResponse(call), 'opening-script', {
                  queueIfBlocked: Boolean(responseState.pendingLanguageSync),
                });
              } else if (call.pendingDecision || call.decisionResolving) {
                // Record what the caller says while Hermes is deciding, but never start a competing
                // Realtime response. Competing responses caused repeated “checking” speech and could
                // prevent the timeout/callback response from being heard.
                emitCallEvent('call.decision.waiting_caller_speech', callId, { transcript });
              } else {
                requestAudioResponseWithOptions(buildConversationResponse(call), 'caller-transcript', {
                  queueIfBlocked: Boolean(responseState.pendingLanguageSync),
                });
              }
            }
          }
        } else if (
          msg.type === 'response.output_audio_transcript.done'
          || msg.type === 'response.audio_transcript.done'
          || msg.type === 'response.output_text.done'
        ) {
          const text = readRealtimeTranscript(msg);
          if (text) {
            call.companionTranscript = [call.companionTranscript, text].filter(Boolean).join('\n');
            emitCallEvent('call.transcript.companion', callId, { transcript: text, isFinal: true });
          }
        } else if (msg.type === 'input_audio_buffer.speech_started') {
          // The Realtime server cancels its current response on barge-in, but it
          // cannot retract frames already queued locally for RTP pacing.
          clearQueuedAudio('caller speech started');
          emitCallEvent('call.speech.started', callId, { channelId });
        } else if (msg.type === 'input_audio_buffer.speech_stopped') {
          emitCallEvent('call.speech.stopped', callId, { channelId });
        } else if (msg.type === 'response.function_call_arguments.done') {
          let arguments_ = {};
          try { arguments_ = JSON.parse(msg.arguments ?? '{}'); } catch {}
          if (msg.name === 'request_decision') {
            try {
              const decision = createPendingDecision(call, arguments_);
              // Session instructions require one short hold notice before waiting for Hermes.
              requestAudioResponseWithOptions({ type: 'response.create', response: { output_modalities: ['audio'] } }, 'decision-wait-notice', { queueIfBlocked: true });
              const response = await new Promise((resolve) => {
                decision.resolve = resolve;
                decision.timer = setTimeout(() => resolve({ decision: 'callback', say: 'Preciso confirmar esse detalhe com Anderson e retorno em breve.' }), 20_000);
              });
              clearTimeout(decision.timer);
              if (decision.status === 'pending') {
                decision.status = 'timed_out';
                call.pendingDecision = null;
                emitCallEvent('call.decision.timed_out', callId, { decisionId: decision.id, timeoutSeconds: 20 });
              }
              wsClient.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: msg.call_id, output: JSON.stringify(response) } }));
              requestAudioResponseWithOptions({ type: 'response.create', response: { output_modalities: ['audio'] } }, 'decision-result', { queueIfBlocked: true });
            } catch (error) {
              emitCallEvent('call.decision.rejected', callId, { error: error.message });
            }
          } else if (msg.name !== 'end_call') {
            emitCallEvent('call.control.rejected', callId, { name: msg.name ?? null, reason: 'tool-not-allowlisted' });
            return;
          } else if (!call.calleeExplicitHangup) {
            emitCallEvent('call.control.rejected', callId, { action: 'end_call', reason: 'callee-has-not-explicitly-requested-hangup' });
            wsClient.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: msg.call_id,
                output: JSON.stringify({ error: 'Do not end the call yet. The callee has not explicitly asked you to hang up.' }),
              },
            }));
            requestAudioResponseWithOptions({ type: 'response.create', response: { output_modalities: ['audio'] } }, 'end-call-rejected', { queueIfBlocked: true });
            return;
          } else {
            const reason = String(arguments_.reason ?? 'caller-requested').slice(0, 240);
            emitCallEvent('call.control.requested', callId, { action: 'end_call', reason });
            armDeferredEnd(reason);
          }
        } else if (msg.type === 'response.done') {
          const finishedReason = call.activeResponseReason ?? null;
          call.activeResponseReason = null;
          flushQueuedResponses(markResponseDone(responseState));
          if (finishedReason === 'decision-result') {
            call.decisionResolving = false;
            emitCallEvent('call.decision.response_completed', callId, {});
          }
          if (deferredEnd) {
            deferredEnd.responseDone = true;
            emitCallEvent('call.control.end_response_completed', callId, { reason: deferredEnd.reason });
            maybeFinishDeferredEnd();
          }
        } else if (msg.type === 'error') {
          responseState.responseInFlight = false;
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
        if (!responseState.sessionConfigured) {
          // Retain at most 1.5 seconds while the server acknowledges session.update.
          if (queuedInboundAudioBeforeSession.length < 75) queuedInboundAudioBeforeSession.push(Buffer.from(rtp.payload));
          return;
        }
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
    localOnly: true,
    allowedExtensions: [...config.allowedExtensions],
  });
});

app.post('/v1/calls/prepare', (req, res, next) => {
  try {
    const call = createPreparedCall(req.body ?? {}, config.allowedExtensions, config.dialplanExtensions);
    if (!call.purpose) throw Object.assign(new Error('A call purpose is required'), { status: 400 });
    calls.set(call.id, call);
    journalCallSnapshot(call);
    emitCallEvent('call.prepared', call.id, { endpoint: call.endpoint, purpose: call.purpose });
    res.status(201).json(publicCall(call));
  } catch (error) {
    next(error);
  }
});

app.post('/v1/calls/:id/start', async (req, res, next) => {
  try {
    const call = calls.get(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    const approved = requireApprovedStart(call, req.body ?? {});
    Object.assign(call, approved);
    // A direct call to a registered local device enters Stasis with the prepared
    // call ID, not the inbound-realtime dialplan argument. Mark it explicitly so
    // StasisStart creates the ExternalMedia/Realtime bridge after the device answers.
    if (call.endpoint.startsWith('PJSIP/')) call.mode = 'realtime';
    await originatePreparedCall(call);
    return res.json(publicCall(call));
  } catch (error) {
    return next(error);
  }
});

app.get('/v1/calls/:id', (req, res) => {
  const call = calls.get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  return res.json(publicCall(call));
});

app.post('/v1/calls/:id/decisions/:decisionId/respond', (req, res, next) => {
  try {
    const call = calls.get(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    const decision = call.pendingDecision;
    if (!decision || decision.id !== req.params.decisionId) return res.status(404).json({ error: 'Pending decision not found' });
    resolvePendingDecision(call, decision, req.body ?? {});
    return res.json(publicCall(call));
  } catch (error) {
    return next(Object.assign(error, { status: 400 }));
  }
});

app.post('/v1/calls/:id/hangup', async (req, res, next) => {
  try {
    const call = calls.get(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (typeof call.realtimeCleanup === 'function') {
      await call.realtimeCleanup('api-hangup');
    } else if (call.status !== 'ended') {
      const channelIds = [...new Set([call.primaryChannelId, call.channelId, call.externalChannelId].filter(Boolean))];
      for (const channelId of channelIds) {
        try {
          await ariRequest(`/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      call.status = 'ended';
      emitCallEvent('call.ended', call.id, { channelId: call.channelId, requestedBy: 'api' });
    }
    return res.json(publicCall(call));
  } catch (error) {
    return next(error);
  }
});

app.post('/legacy/calls', async (req, res, next) => {
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

app.post('/legacy/calls/realtime', async (req, res, next) => {
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
  console.log(`Asterisk Hermes companion listening on :${config.port}`);
});
