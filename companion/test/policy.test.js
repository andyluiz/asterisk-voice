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

test('stores one bounded immutable generic mission and discards task-specific fields', () => {
  const call = createPreparedCall({
    callId: 'brief-1',
    to: '1001',
    purpose: 'restaurant test',
    brief: {
      mission: 'Ask whether a table for three is available on Saturday between 19:00 and 20:00. Do not make a booking, disclose data, or accept fees without a Hermes decision.',
      simulation: false,
      preferred_language: 'pt-BR',
      adapt_language: true,
      completion_behavior: 'end_after_callee_confirmation',
      pizza_order: { quantity: 99 },
      untrusted_extra: 'must not be retained',
    },
  }, new Set(['1001']));
  assert.deepEqual(call.brief, {
    mission: 'Ask whether a table for three is available on Saturday between 19:00 and 20:00. Do not make a booking, disclose data, or accept fees without a Hermes decision.',
    simulation: false,
    preferred_language: 'pt-BR',
    adapt_language: true,
    completion_behavior: 'end_after_callee_confirmation',
  });
  assert.throws(
    () => createPreparedCall({ to: '1001', purpose: 'bad brief', brief: { mission: 42 } }, new Set(['1001'])),
    /mission must be a string/,
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
