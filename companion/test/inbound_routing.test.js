import assert from 'node:assert/strict';
import test from 'node:test';
import { inboundWebhookRouteForCaller, normalizeCallerExtension } from '../src/inbound_routing.js';

const env = {
  INBOUND_HERMES_WEBHOOK_ROUTES: JSON.stringify({
    '1001': { profile: 'hal', url: 'http://127.0.0.1:8644/webhooks/inbound-admission', secretEnv: 'INBOUND_HERMES_WEBHOOK_HAL_SECRET' },
    '1002': { profile: 'nova', enabled: false, url: '', secretEnv: 'INBOUND_HERMES_WEBHOOK_NOVA_SECRET' },
    '1003': { profile: 'kairo', enabled: false, url: '', secretEnv: 'INBOUND_HERMES_WEBHOOK_KAIRO_SECRET' },
  }),
  INBOUND_HERMES_WEBHOOK_HAL_SECRET: 'hal-secret',
  INBOUND_HERMES_WEBHOOK_NOVA_SECRET: 'nova-secret',
  INBOUND_HERMES_WEBHOOK_KAIRO_SECRET: 'kairo-secret',
};

test('normalizes formatted local extensions but never SIP identity or E.164', () => {
  assert.equal(normalizeCallerExtension(' 1-001 '), '1001');
  assert.equal(normalizeCallerExtension('PJSIP/1001'), null);
  assert.equal(normalizeCallerExtension('+31 6 1234 5678'), null);
  assert.equal(normalizeCallerExtension('anonymous'), null);
});

test('routes 1001 only to Hal with an authenticated loopback endpoint', () => {
  const route = inboundWebhookRouteForCaller('1-001', env);
  assert.deepEqual(route, {
    extension: '1001', profile: 'hal', url: 'http://127.0.0.1:8644/webhooks/inbound-admission', secret: 'hal-secret',
    timeoutMs: 4000, retryCount: 2, retryDelayMs: 250,
  });
});

test('keeps Nova and Kairo disabled and has no default or unknown fallback', () => {
  assert.equal(inboundWebhookRouteForCaller('1002', env), null);
  assert.equal(inboundWebhookRouteForCaller('1003', env), null);
  assert.equal(inboundWebhookRouteForCaller('9999', env), null);
  assert.equal(inboundWebhookRouteForCaller('+31612345678', env), null);
});

test('refuses a default profile or non-loopback route even if configured', () => {
  const invalid = { ...env, INBOUND_HERMES_WEBHOOK_ROUTES: JSON.stringify({
    '1001': { profile: 'default', url: 'http://127.0.0.1:8644/webhooks/inbound-admission', secretEnv: 'INBOUND_HERMES_WEBHOOK_HAL_SECRET' },
  }) };
  assert.throws(() => inboundWebhookRouteForCaller('1001', invalid), /invalid profile/);
  const remote = { ...env, INBOUND_HERMES_WEBHOOK_ROUTES: JSON.stringify({
    '1001': { profile: 'hal', url: 'http://gateway.example/webhooks/inbound-admission', secretEnv: 'INBOUND_HERMES_WEBHOOK_HAL_SECRET' },
  }) };
  assert.throws(() => inboundWebhookRouteForCaller('1001', remote), /loopback/);
});
