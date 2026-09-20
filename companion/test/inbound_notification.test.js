import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { notifyInboundAdmission } from '../src/inbound_notification.js';

const webhook = Object.freeze({
  profile: 'hal',
  url: 'http://127.0.0.1:8644/webhooks/inbound-admission',
  secret: 'test-secret',
  timeoutMs: 1000,
  retryCount: 1,
  retryDelayMs: 1,
});

test('does not notify when no profile route is selected', async () => {
  assert.deepEqual(await notifyInboundAdmission({ sessionId: 'opaque' }, null), {
    delivered: false,
    skipped: 'not_configured',
  });
});

test('sends a replay-protected, idempotent admission notification with opaque profile routing metadata only', async () => {
  const calls = [];
  const result = await notifyInboundAdmission({
    sessionId: 'inbound-opaque-id', callerProfile: 'hal', callerClass: 'unknown', callerLabel: null, callerRelation: null, startedAt: '2026-09-12T00:00:00.000Z',
  }, webhook, {
    now: () => 1_700_000_000_000,
    sleep: async () => {},
    fetchFn: async (_url, options) => {
      calls.push(options);
      return { status: calls.length === 1 ? 503 : 202 };
    },
  });
  assert.equal(result.delivered, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls[0].headers['X-Request-ID'], calls[1].headers['X-Request-ID']);
  assert.equal(calls[0].headers['X-Webhook-Timestamp'], '1700000000');
  assert.equal(calls[0].headers['X-Webhook-Signature-V2'], createHmac('sha256', 'test-secret')
    .update(`1700000000.${calls[0].body}`).digest('hex'));
  assert.deepEqual(JSON.parse(calls[0].body), {
    event_type: 'inbound_admission_requested',
    admission: {
      sessionId: 'inbound-opaque-id', callerProfile: 'hal', callerClass: 'unknown', callerLabel: null, callerRelation: null, startedAt: '2026-09-12T00:00:00.000Z',
    },
  });
  assert.doesNotMatch(calls[0].body, /1001|PJSIP|\+31/);
});
