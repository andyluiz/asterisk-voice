import test from 'node:test';
import assert from 'node:assert/strict';
import { HermesClient, normalizeHermesResponse } from '../src/hermes_client.js';

test('HermesClient posts an authenticated bounded handoff request', async () => {
  let request;
  const client = new HermesClient({
    baseUrl: 'http://127.0.0.1:8788',
    token: 'bridge-token',
    path: '/internal/voice/handoff',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'completed', say: 'The result is ready.', requires_confirmation: false }),
      };
    },
  });

  const result = await client.request({
    requestId: 'req-1',
    callId: 'call-1',
    profile: 'hal',
    question: 'Check the private preference.',
    context: { direction: 'inbound' },
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
  });

  assert.deepEqual(result, {
    status: 'completed',
    say: 'The result is ready.',
    requiresConfirmation: false,
  });
  assert.equal(request.url, 'http://127.0.0.1:8788/internal/voice/handoff');
  assert.equal(request.options.headers.Authorization, 'Bearer bridge-token');
  assert.equal(request.options.headers['Idempotency-Key'], 'req-1');
  assert.equal(request.body.request_id, 'req-1');
  assert.equal(request.body.call_id, 'call-1');
  assert.equal(request.body.profile, 'hal');
  assert.equal(request.body.kind, 'voice_handoff');
  assert.equal(request.body.context.direction, 'inbound');
});

test('HermesClient rejects malformed responses', () => {
  assert.throws(
    () => normalizeHermesResponse({ status: 'completed', say: '' }),
    /must include say text/,
  );
  assert.throws(
    () => normalizeHermesResponse({ status: 'unknown', say: 'Nope' }),
    /status is invalid/,
  );
});

test('HermesClient turns a deadline abort into a timeout error', async () => {
  const client = new HermesClient({
    baseUrl: 'http://127.0.0.1:8788',
    token: 'bridge-token',
    timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });

  await assert.rejects(
    client.request({ requestId: 'req-timeout', callId: 'call-1', question: 'Wait.' }),
    (error) => error.code === 'HERMES_TIMEOUT',
  );
});
