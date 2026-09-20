import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInboundCall,
  createInboundAdmission,
  decideInboundAdmission,
  trustedVoiceContext,
} from '../src/inbound_policy.js';

test('trusted inbound caller receives Hermes Voice with only curated context', () => {
  const call = createInboundCall({
    channelId: 'chan-known',
    channelName: 'PJSIP/1001-0001',
    callerNumber: '+31 6 8623 4690',
    callerName: 'Anderson',
    trustedCallerIds: new Set(['+31686234690']),
    voiceContext: 'Anderson prefers concise Brazilian Portuguese replies.',
  });

  assert.equal(call.direction, 'inbound');
  assert.equal(call.callerClass, 'trusted');
  assert.equal(call.from, '+31686234690');
  assert.equal(call.brief.interaction_mode, 'hermes_voice');
  assert.equal(call.brief.preferred_language, 'pt-BR');
  assert.match(call.brief.voice_context, /Trusted caller label: trusted caller/);
  assert.match(call.brief.voice_context, /Anderson prefers concise Brazilian Portuguese replies/);
  assert.doesNotMatch(call.brief.voice_context, /\+31|PJSIP\/1001|Anderson$/m);
});

test('unknown inbound caller receives a restricted mission without private context', () => {
  const call = createInboundCall({
    channelId: 'chan-unknown',
    channelName: 'PJSIP/external-0001',
    callerNumber: '+31 (0) 20 555 0100',
    callerName: 'Untrusted display name',
    trustedCallerIds: new Set(['+31686234690']),
    voiceContext: 'This must not be exposed.',
  });

  assert.equal(call.direction, 'inbound');
  assert.equal(call.callerClass, 'unknown');
  assert.equal(call.from, '+31205550100');
  assert.equal(call.brief.interaction_mode, 'inbound_restricted');
  assert.match(call.brief.mission, /unrecognized caller/);
  assert.equal(call.brief.voice_context, null);
  assert.doesNotMatch(JSON.stringify(call.brief), /This must not be exposed/);
});

test('withheld or missing caller identity is unknown and is never trusted', () => {
  const call = createInboundCall({
    channelId: 'chan-hidden',
    channelName: 'PJSIP/external-0002',
    callerNumber: 'anonymous',
    trustedCallerIds: new Set(['anonymous']),
    voiceContext: 'This must not be exposed.',
  });

  assert.equal(call.callerClass, 'unknown');
  assert.equal(call.from, null);
  assert.equal(call.brief.interaction_mode, 'inbound_restricted');
});

test('inbound Stasis begins pending admission without a bridge or caller supplied prompt data', () => {
  const call = createInboundCall({
    channelId: 'ari-channel-1',
    channelName: 'PJSIP/1001-00000001',
    callerNumber: '+31 6 1234 5678',
    callerName: 'Untrusted SIP display name',
    trustedCallers: new Map([['+31612345678', { label: 'Anderson', relation: 'owner' }]]),
    voiceContext: 'Curated context only.',
    admissionTimeoutMs: 30_000,
    now: new Date('2026-09-12T10:00:00.000Z'),
  });

  assert.equal(call.status, 'pending_admission');
  assert.equal(call.bridgeStarted, undefined);
  assert.equal(call.admission.status, 'pending');
  assert.deepEqual(call.admission.request, {
    sessionId: call.id,
    callerProfile: null,
    callerClass: 'trusted',
    callerLabel: 'Anderson',
    callerRelation: 'owner',
    startedAt: '2026-09-12T10:00:00.000Z',
    deadlineAt: '2026-09-12T10:00:30.000Z',
  });
  const promptContext = trustedVoiceContext(call);
  assert.match(promptContext, /Anderson/);
  assert.match(promptContext, /owner/);
  assert.match(promptContext, /2026-09-12T10:00:00\.000Z/);
  assert.match(promptContext, new RegExp(call.id));
  assert.doesNotMatch(promptContext, /\+31612345678|Untrusted SIP display name|ari-channel-1/);
});

test('only explicit answer admits an inbound call; timeout and leave_ringing retain ringing', () => {
  const pending = createInboundAdmission({ callId: 'inbound-1' });
  assert.deepEqual(decideInboundAdmission(pending, 'leave_ringing'), { status: 'left_ringing', answer: false });

  const timeout = createInboundAdmission({ callId: 'inbound-2' });
  assert.deepEqual(decideInboundAdmission(timeout, 'timeout'), { status: 'timed_out', answer: false });

  const answer = createInboundAdmission({ callId: 'inbound-3' });
  assert.deepEqual(decideInboundAdmission(answer, 'answer'), { status: 'admitted', answer: true });
  assert.throws(() => decideInboundAdmission(answer, 'answer'), /no longer pending/);
});
