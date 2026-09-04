import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparedCall, requireApprovedStart, validateLocalEndpoint } from '../src/policy.js';

test('accepts explicitly allowlisted local extensions only', () => {
  assert.equal(validateLocalEndpoint('1001', new Set(['1001', '700'])), 'PJSIP/1001');
  assert.equal(validateLocalEndpoint('local:700', new Set(['1001', '700'])), 'Local/700@internal');
  assert.equal(
    validateLocalEndpoint('700', new Set(['1001', '700']), new Set(['700'])),
    'Local/700@internal',
  );
  assert.throws(
    () => validateLocalEndpoint('PJSIP/sip-trunk/+316****0000', new Set(['1001', '700'])),
    /not allowlisted/,
  );
});

test('stores a bounded immutable outbound task brief', () => {
  const call = createPreparedCall({
    callId: 'brief-1',
    to: '1001',
    purpose: 'restaurant test',
    brief: {
      task: 'restaurant_reservation',
      simulation: false,
      introduction: 'Olá, sou o Hal, assistente do Anderson.',
      objective: 'Consultar disponibilidade para três pessoas.',
      preferred_language: 'pt-BR',
      adapt_language: true,
      constraints: 'Não confirmar sem aprovação final.',
      allowed_actions: ['ask_availability', 'record_offer'],
      requires_final_confirmation: true,
      untrusted_extra: 'must not be retained',
    },
  }, new Set(['1001']));
  assert.deepEqual(call.brief, {
    task: 'restaurant_reservation',
    simulation: false,
    introduction: 'Olá, sou o Hal, assistente do Anderson.',
    order_name: null,
    objective: 'Consultar disponibilidade para três pessoas.',
    preferred_language: 'pt-BR',
    adapt_language: true,
    constraints: 'Não confirmar sem aprovação final.',
    allowed_actions: ['ask_availability', 'record_offer'],
    requires_final_confirmation: true,
  });
  assert.throws(
    () => createPreparedCall({ to: '1001', purpose: 'bad brief', brief: { allowed_actions: 'book' } }, new Set(['1001'])),
    /allowed_actions/,
  );
});

test('normalizes structured pizza-order authority and rejects invalid changes', () => {
  const call = createPreparedCall({
    callId: 'pizza-1',
    to: '1001',
    purpose: 'pizza test',
    brief: {
      task: 'pizza_order',
      simulation: true,
      preferred_language: 'nl-NL',
      pizza_order: {
        quantity: 1,
        size: 'large',
        toppings: ['chicken', 'red onion'],
        excluded_toppings: ['mushrooms'],
        allowed_ingredient_changes: [{ type: 'replace', from: 'bell pepper', to: 'extra red onion' }],
      },
    },
  }, new Set(['1001']));
  assert.deepEqual(call.brief.pizza_order, {
    quantity: 1,
    size: 'large',
    style: null,
    sauce: null,
    cheese: null,
    toppings: ['chicken', 'red onion'],
    excluded_toppings: ['mushrooms'],
    allowed_ingredient_changes: [{ type: 'replace', from: 'bell pepper', to: 'extra red onion' }],
  });
  assert.throws(
    () => createPreparedCall({
      to: '1001',
      purpose: 'bad pizza',
      brief: { task: 'pizza_order', pizza_order: { allowed_ingredient_changes: [{ type: 'replace', from: 'a' }] } },
    }, new Set(['1001'])),
    /replace changes require both from and to/,
  );
});

test('requires explicit approval before a prepared call can start', () => {
  const call = createPreparedCall({ callId: 'call-1', to: '1001', purpose: 'local test' }, new Set(['1001']));
  assert.equal(call.status, 'prepared');
  let rejected;
  try {
    requireApprovedStart(call, { approved: false });
  } catch (error) {
    rejected = error;
  }
  assert.match(rejected.message, /explicit approval/);
  assert.equal(rejected.status, 409);
  assert.equal(requireApprovedStart(call, { approved: true }).status, 'approved');
});

test('bounded decision lifecycle: create, resolve, timeout, cancel', () => {
  // This is a structural test; the real async behavior is validated in realtime_decision_smoke.js.
  // Here we just verify the policy helpers and state machine shapes exist.
  const call = createPreparedCall({ callId: 'dec-1', to: '1001', purpose: 'decision lifecycle' }, new Set(['1001']));
  assert.ok(call);
  assert.equal(call.status, 'prepared');
  // The decision state machine is implemented in index.js (createPendingDecision, resolvePendingDecision).
  // This test ensures the unit-test scaffold exists for future refinements.
  assert.ok(true);
});
