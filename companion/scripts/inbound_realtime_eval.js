#!/usr/bin/env node
/**
 * Private, no-Asterisk evaluation of the deployed inbound Realtime prompt.
 * Uses anonymized utterances drawn from Anderson's inbound-call transcripts.
 * It never originates a call or invokes Hermes; tool calls are captured only.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';
import { buildExactInboundGreetingResponse, buildRealtimeSessionUpdate } from '../src/realtime.js';
import { callerHandoffTranscript } from '../src/handoff_context.js';
import { appendConversationTurn, formatRecentConversation } from '../src/conversation_context.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const envPath = path.join(root, '.env');
const outputPath = process.argv[2] || path.join(root, 'recordings', `inbound-realtime-eval-${Date.now()}.json`);

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!raw || raw.trimStart().startsWith('#') || !raw.includes('=')) continue;
    const index = raw.indexOf('=');
    values[raw.slice(0, index)] = raw.slice(index + 1).replace(/^['"]|['"]$/g, '');
  }
  return values;
}

const env = readEnv(envPath);
const apiKey = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
const model = process.env.REALTIME_MODEL || env.REALTIME_MODEL || 'gpt-realtime-2.1-mini';
const base = process.env.OPENAI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com';
const wsUrl = new URL('/v1/realtime', `${base.replace(/^http/i, 'ws').replace(/\/+$/, '')}/`);
wsUrl.searchParams.set('model', model);

const config = {
  realtimeModel: model,
  realtimeVoice: env.REALTIME_VOICE || 'marin',
  realtimeVadSilenceMs: Number(env.REALTIME_VAD_SILENCE_MS || 450),
  realtimeInstructions: process.env.REALTIME_INSTRUCTIONS ?? env.REALTIME_INSTRUCTIONS ?? '',
  realtimeIntroduction: env.REALTIME_INTRODUCTION || '',
  transcriptionModel: env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
  inboundGreeting: env.INBOUND_GREETING || '',
  realtimeGreeting: env.REALTIME_GREETING || '',
};

const call = {
  direction: 'inbound',
  activeLanguage: 'pt-BR',
  brief: {
    interaction_mode: 'hermes_voice',
    preferred_language: 'pt-BR',
    adapt_language: true,
    completion_behavior: 'callee_request_only',
    mission: 'Have a natural personal voice conversation with the trusted caller. Handle casual conversation directly and use Hermes only for research, private data, decisions, tools, or external actions.',
    voice_context: 'Trusted caller. Anderson prefers concise, natural Brazilian Portuguese replies.',
  },
};

const scenarios = [
  {
    name: 'opening-is-literal',
    turns: [],
    check: ({ transcript }) => ({
      exactGreeting: transcript.trim() === config.inboundGreeting,
      noGenericExpansion: !/(bora la|que bom falar|estou aqui para ajudar|e so me dizer)/i.test(transcript),
    }),
  },
  {
    name: 'casual-conversation-is-brief',
    turns: ['Oi, Hal, tudo bem? Como estão as coisas por aí?'],
    check: ({ transcript, functions }) => ({
      noToolCall: functions.length === 0,
      concise: transcript.trim().length <= 180,
      noGenericSalesPitch: !/(estou pronto para te ajudar|e so me contar|como posso colaborar)/i.test(transcript),
    }),
  },
  {
    name: 'logs-question-keeps-current-intent',
    turns: ['Tá certo. Foi o seguinte, verifica...', 'que essa chamada foi atendida automaticamente.'],
    check: ({ functions, handoff }) => {
      const question = handoff?.question || '';
      return {
        requestedHermes: functions.some((f) => f.name === 'request_hermes'),
        mentionsAutomaticCall: /chamada.*automatic|automatic.*chamada/i.test(question),
        includesChronologicalContext: /Conversation context \(chronological\)/.test(handoff?.context?.recent_conversation || ''),
      };
    },
  },
  {
    name: 'wiki-query-is-not-preemptively-refused',
    // Reproduces the failure in the recorded call: a wrong refusal, then the
    // caller corrects it and explicitly identifies Wiki as the data source.
    history: [
      { role: 'user', text: 'Verifica com o Raul qual que é a placa do carro Corolla.' },
      { role: 'assistant', text: 'Entendi o que você quer, mas eu não tenho como ver placas ou acessar dados externos.' },
    ],
    turns: ['Não, você está com a Wiki. Faça isso, por favor.'],
    check: ({ transcript, functions, handoff }) => {
      const question = handoff?.question || '';
      return {
        requestedHermes: functions.some((f) => f.name === 'request_hermes'),
        preservesWikiAndVehicle: /wiki/i.test(question) && /corolla/i.test(question) && /placa/i.test(question),
        preservesCorrection: /não,? você está com a wiki/i.test(question),
        includesPriorRefusalInContext: /Hal:.*não tenho como (ver placas|acessar dados externos)/i.test(handoff?.context?.recent_conversation || ''),
        noPreemptiveRefusal: !/(nao consigo|não consigo|nao tenho como|não tenho como)/i.test(transcript),
      };
    },
  },
  {
    name: 'explicit-hangup-calls-end-tool',
    turns: ['Agora eu quero encerrar a chamada.'],
    check: ({ functions }) => ({
      requestedEnd: functions.some((f) => f.name === 'end_call'),
    }),
  },
];

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    const timer = setTimeout(() => reject(new Error('Timed out opening Realtime WebSocket')), 20_000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', reject);
  });
}

function awaitResponse(ws, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const transcript = [];
    const functions = [];
    const timer = setTimeout(() => done(new Error('Timed out waiting for response.done')), timeoutMs);
    const done = (error, result) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (error) reject(error); else resolve(result);
    };
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'response.output_audio_transcript.done' || message.type === 'response.output_text.done') {
        const text = message.transcript || message.text || '';
        if (text && !transcript.includes(text)) transcript.push(text);
      }
      if (message.type === 'response.function_call_arguments.done') {
        let args = {};
        try { args = JSON.parse(message.arguments || '{}'); } catch {}
        functions.push({ name: message.name, arguments: args });
      }
      if (message.type === 'error') done(new Error(message.error?.message || 'Realtime error'));
      if (message.type === 'response.done') done(null, { transcript: transcript.join('\n').trim(), functions });
    };
    ws.on('message', onMessage);
  });
}

async function runScenario(scenario) {
  const ws = await connect();
  try {
    const update = buildRealtimeSessionUpdate(call, config);
    ws.send(JSON.stringify({ type: 'session.update', session: update.session }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Match production ordering: the mandatory opening exists in history before caller speech.
    ws.send(JSON.stringify(buildExactInboundGreetingResponse(config.inboundGreeting)));
    const opening = await awaitResponse(ws);
    let result = opening;
    let callerTranscript = '';
    let conversationTurns = appendConversationTurn([], 'assistant', opening.transcript);
    const turnResults = [];
    for (const item of scenario.history || []) {
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: item.role, content: [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.text }] },
      }));
      conversationTurns = appendConversationTurn(conversationTurns, item.role, item.text);
      if (item.role === 'user') callerTranscript = [callerTranscript, item.text].filter(Boolean).join('\n');
    }
    for (const turn of scenario.turns) {
      callerTranscript = [callerTranscript, turn].filter(Boolean).join('\n');
      conversationTurns = appendConversationTurn(conversationTurns, 'caller', turn);
      ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn }] } }));
      ws.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'] } }));
      result = await awaitResponse(ws);
      conversationTurns = appendConversationTurn(conversationTurns, 'assistant', result.transcript);
      turnResults.push({ turn, ...result });
    }
    const handoff = result.functions.some((f) => f.name === 'request_hermes') ? {
      question: callerHandoffTranscript(callerTranscript),
      context: { recent_conversation: formatRecentConversation(conversationTurns) },
    } : null;
    const checks = scenario.check({ ...result, handoff });
    const failedChecks = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
    return { name: scenario.name, ok: failedChecks.length === 0, opening, turnResults, handoff, ...result, checks, failedChecks };
  } finally {
    ws.close();
  }
}

const results = [];
for (const scenario of scenarios) {
  try { results.push(await runScenario(scenario)); }
  catch (error) { results.push({ name: scenario.name, ok: false, error: error.message, failedChecks: ['runtime'] }); }
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify({ model, ranAt: new Date().toISOString(), results }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ outputPath, results: results.map((r) => ({ name: r.name, ok: r.ok, failedChecks: r.failedChecks })) }));
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
