import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REALTIME_INTRODUCTION,
  DEFAULT_REALTIME_VOICE,
  buildRealtimeSessionUpdate,
  detectCallLanguage,
} from '../src/realtime.js';
import {
  acknowledgeSessionUpdated,
  beginLanguageSync,
  createRealtimeResponseState,
  markOutputAudioStarted,
  markResponseDone,
  requestResponse,
} from '../src/realtime_state.js';

const config = {
  realtimeModel: 'gpt-realtime-2',
  realtimeVoice: DEFAULT_REALTIME_VOICE,
  realtimeVadSilenceMs: 450,
  realtimeInstructions: 'You are Hal.',
  realtimeIntroduction: DEFAULT_REALTIME_INTRODUCTION,
  transcriptionModel: 'gpt-4o-mini-transcribe',
};

test('session.created -> session.update -> session.updated gates queued responses', () => {
  const state = createRealtimeResponseState(() => 'sync-1');
  const queued = requestResponse(state, { type: 'response.create', response: {} }, 'opening-script', { queueIfBlocked: true });
  assert.equal(queued.sent, false);
  assert.equal(queued.queued, true);

  const ack = acknowledgeSessionUpdated(state);
  assert.equal(ack.type, 'initial-session-configured');
  assert.equal(ack.flushed.length, 1);
  assert.equal(ack.flushed[0].reason, 'opening-script');
  assert.equal(state.responseInFlight, true);
});

test('generated language-sync item IDs meet Realtime maximum length', () => {
  const sync = beginLanguageSync(createRealtimeResponseState(), 'pt-BR');
  assert.ok(sync.itemId.length <= 32);
  assert.match(sync.itemId, /^[0-9a-f]+$/);
});

test('language change waits for session.updated before the next response', () => {
  const state = createRealtimeResponseState(() => 'lang-sync-1');
  acknowledgeSessionUpdated(state);
  markResponseDone(state);
  beginLanguageSync(state, 'pt-BR');

  const queued = requestResponse(state, { type: 'response.create', response: {} }, 'caller-transcript', { queueIfBlocked: true });
  assert.equal(queued.queued, true);

  const sessionAck = acknowledgeSessionUpdated(state);
  assert.equal(sessionAck.type, 'language-session-updated');
  assert.equal(sessionAck.flushed.length, 1);
  assert.equal(sessionAck.flushed[0].reason, 'caller-transcript');
});

test('observed Portuguese pizza transcript triggers a guarded pt-BR synchronization', () => {
  // Real call excerpt: the companion detected Portuguese but once answered in Dutch
  // despite a session update acknowledgement. This test locks down the local event order.
  const transcript = 'Nós não temos pimentão mais.';
  assert.equal(detectCallLanguage(transcript), 'pt-BR');

  const state = createRealtimeResponseState(() => 'observed-pt-br-sync');
  acknowledgeSessionUpdated(state);
  markResponseDone(state);
  const sync = beginLanguageSync(state, detectCallLanguage(transcript));
  const delayedResponse = requestResponse(
    state,
    { type: 'response.create', response: { output_modalities: ['audio'] } },
    'observed-pizza-unavailability',
    { queueIfBlocked: true },
  );
  assert.equal(delayedResponse.queued, true);
  const sessionAck = acknowledgeSessionUpdated(state);
  assert.equal(sessionAck.flushed[0].reason, 'observed-pizza-unavailability');
});

test('caller transcript responses do not create concurrent response.create events', () => {
  const state = createRealtimeResponseState(() => 'sync-1');
  acknowledgeSessionUpdated(state);
  const first = requestResponse(state, { type: 'response.create', response: {} }, 'first-turn');
  assert.equal(first.sent, true);
  const second = requestResponse(state, { type: 'response.create', response: {} }, 'second-turn');
  assert.equal(second.sent, false);
  assert.equal(second.queued, false);

  const queuedToolFollowup = requestResponse(state, { type: 'response.create', response: {} }, 'decision-result', { queueIfBlocked: true });
  assert.equal(queuedToolFollowup.queued, true);

  const flushed = markResponseDone(state);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].reason, 'decision-result');
  assert.equal(state.responseInFlight, true);
});

test('buildRealtimeSessionUpdate uses structured pizza authority and outbound-safe defaults', () => {
  const update = buildRealtimeSessionUpdate({
    activeLanguage: 'nl-NL',
    brief: {
      task: 'pizza_order',
      simulation: true,
      preferred_language: 'nl-NL',
      adapt_language: true,
      allowed_actions: ['ask_availability'],
      order_name: 'Anderson',
      requires_final_confirmation: true,
      pizza_order: {
        quantity: 1,
        size: 'large',
        sauce: 'tomato sauce',
        cheese: 'mozzarella',
        toppings: ['chicken', 'red onion', 'bell pepper', 'olives'],
        excluded_toppings: ['mushrooms'],
        allowed_ingredient_changes: [{ type: 'replace', from: 'bell pepper', to: 'extra red onion' }],
      },
    },
  }, config);
  const instructions = update.session.instructions;
  assert.match(instructions, /You initiated this outbound call/);
  assert.match(instructions, /STRUCTURED PIZZA ORDER \(authoritative\):/);
  assert.match(instructions, /Quantity is fixed at 1/);
  assert.match(instructions, /Never invent a substitute yourself/);
  assert.match(instructions, /PIZZA OPENING: Start simply and naturally/);
  assert.match(instructions, /Do not introduce yourself, volunteer a name/);
  assert.match(instructions, /Only if the callee specifically asks whose name the order is under, say exactly: "Anderson"/);
  assert.match(instructions, /Follow the pizza opening rule; do not add a self-introduction/);
  assert.doesNotMatch(instructions, /first response must be exactly/);
  assert.doesNotMatch(instructions, /How can I help\?/);
  assert.equal(update.session.audio.output.voice, 'ash');
});

test('follow-up session.update omits voice after audio has started', () => {
  const state = createRealtimeResponseState(() => 'sync-1');
  markOutputAudioStarted(state);
  const update = buildRealtimeSessionUpdate({ activeLanguage: 'pt-BR', brief: {} }, config, {
    includeVoice: !state.outputAudioStarted,
  });
  assert.equal(update.session.audio.output.voice, undefined);
});
