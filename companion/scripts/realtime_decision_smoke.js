#!/usr/bin/env node
/** No-Asterisk live test: Realtime requests a bounded Hermes decision and resumes. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';
const root = path.resolve(import.meta.dirname, '..', '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const [k, ...v] = l.split('='); return [k, v.join('=')]; }));
const key = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY is not configured');
const model = process.env.REALTIME_MODEL || env.REALTIME_MODEL || 'gpt-realtime-mini';
const base = (process.env.OPENAI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/^http/i, 'ws').replace(/\/$/, '');
const url = new URL('/v1/realtime', `${base}/`); url.searchParams.set('model', model);
const voice = process.env.REALTIME_TEST_VOICE || 'marin';
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
const transcripts = []; let tool = null; let holdSaid = false; let toolResultSpoken = false;
const fail = (e) => { console.error(e.message || e); process.exit(1); };
const timeout = setTimeout(() => fail(new Error('decision smoke test timed out')), 60000);
ws.on('open', () => {
  console.log('[test] WS open, sending session.update');
  ws.send(JSON.stringify({ type: 'session.update', session: {
    type: 'realtime', model, output_modalities: ['audio'], tool_choice: 'auto',
    instructions: 'You are Hal, a bounded restaurant booking caller. The brief permits only 19:00–20:00. If offered anything outside it, first tell the restaurant in Brazilian Portuguese to wait while you check with Anderson, then call request_decision. Do not confirm before the tool result. After a tool result, say only its say text.',
    audio: { output: { format: { type: 'audio/pcmu' }, voice } },
    tools: [{ type: 'function', name: 'request_decision', description: 'Ask Hermes about an out-of-range offer after telling the caller to wait.', parameters: { type: 'object', properties: { kind: { type: 'string' }, candidate: { type: 'object' }, question: { type: 'string' } }, required: ['kind', 'candidate', 'question'], additionalProperties: false } }],
  } }));
  console.log('[test] Sending restaurant offer at 20:30 (outside 19:00-20:00)');
  ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Só temos mesa às 20:30. Posso confirmar?' }] } }));
  ws.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'] } }));
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'response.output_audio_transcript.done') { transcripts.push(m.transcript || ''); console.log('[test] transcript:', m.transcript); }
  if (m.type === 'response.output_audio_transcript.delta') { process.stdout.write('.'); }
  if (m.type === 'response.function_call_arguments.done' && m.name === 'request_decision') {
    tool = { callId: m.call_id, args: JSON.parse(m.arguments || '{}') };
    console.log('[test] TOOL CALLED request_decision:', JSON.stringify(tool.args));
    setTimeout(() => {
      console.log('[test] Sending tool result (decline)');
      ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: tool.callId, output: JSON.stringify({ decision: 'decline', say: 'Obrigado, mas precisamos de algo entre dezenove e vinte horas.' }) } }));
      ws.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'], instructions: 'Say exactly the authorized say text from the tool result.' } }));
    }, 1000);
  }
  if (m.type === 'response.done') {
    const text = transcripts.join('\n').toLowerCase();
    if (!holdSaid && /um momento|aguarde|esper/.test(text)) {
      console.log('[test] HOLD LINE DETECTED');
      holdSaid = true;
    }
    if (toolResultSpoken) return;
    if (holdSaid && /entre (as )?(dezenove|19).*(e )?(vinte|20)/.test(text)) {
      toolResultSpoken = true;
      console.log('[test] TOOL RESULT SPOKEN');
      clearTimeout(timeout);
      console.log(JSON.stringify({ ok: true, tool, transcripts }));
      ws.close();
    }
  }
  if (m.type === 'error') fail(new Error(m.error?.message || 'Realtime error'));
});
ws.on('error', fail);
