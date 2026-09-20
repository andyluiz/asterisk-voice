import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRealtimeSessionUpdate, inboundGreetingForCall } from '../src/realtime.js';
import { callerExplicitlyRequestedHangup } from '../src/hangup_policy.js';

test('inbound greeting prefers configured Portuguese inbound greeting', () => {
  assert.equal(
    inboundGreetingForCall({ direction: 'inbound' }, {
      inboundGreeting: 'Olá, Anderson. Aqui é o Hal. Como posso ajudar?',
      realtimeGreeting: 'Hello Anderson, this is Hal. How can I help?',
    }),
    'Olá, Anderson. Aqui é o Hal. Como posso ajudar?',
  );
});

test('explicit Portuguese caller request authorizes inbound hangup', () => {
  assert.equal(callerExplicitlyRequestedHangup('Agora eu quero encerrar a chamada.'), true);
  assert.equal(callerExplicitlyRequestedHangup('Na, podjela.'), false);
});

test('Hermes handoff instruction delegates the caller request to application context', () => {
  const update = buildRealtimeSessionUpdate({
    direction: 'inbound',
    activeLanguage: 'pt-BR',
    brief: { interaction_mode: 'hermes_voice', preferred_language: 'pt-BR' },
  }, {
    realtimeModel: 'gpt-realtime-2.1-mini', realtimeVoice: 'marin', realtimeVadSilenceMs: 450,
    realtimeInstructions: 'You are Hal.', transcriptionModel: 'gpt-4o-mini-transcribe',
  });
  assert.match(update.session.instructions, /recent words and chronological context to Hal as the authoritative request/i);
});

test('inbound prompt is concise and prohibits unsolicited generic offers', () => {
  const update = buildRealtimeSessionUpdate({
    direction: 'inbound',
    activeLanguage: 'pt-BR',
    brief: { interaction_mode: 'hermes_voice', preferred_language: 'pt-BR' },
  }, {
    realtimeModel: 'gpt-realtime-2.1-mini', realtimeVoice: 'marin', realtimeVadSilenceMs: 450,
    realtimeInstructions: 'You are Hal.', transcriptionModel: 'gpt-4o-mini-transcribe',
  });
  assert.match(update.session.instructions, /one short sentence/i);
  assert.match(update.session.instructions, /do not offer generic help/i);
  assert.doesNotMatch(update.session.instructions, /varied intonation|genuinely pleased|thoughtful, attentive person/i);
});
