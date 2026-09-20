import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPendingInboundStasisChannel,
  reconcileInboundChannels,
} from '../src/inbound_reconciliation.js';

const inboundChannel = {
  id: 'PJSIP/700-00000001',
  name: 'PJSIP/700-00000001',
  state: 'Ring',
  caller: { number: '+31612345678' },
  dialplan: {
    app_name: 'Stasis',
    app_data: 'openclaw,inbound-realtime',
  },
};

test('detects only ringing inbound-realtime channels waiting in the configured Stasis app', () => {
  assert.equal(isPendingInboundStasisChannel(inboundChannel, 'openclaw'), true);
  assert.equal(isPendingInboundStasisChannel({ ...inboundChannel, state: 'Up' }, 'openclaw'), false);
  assert.equal(isPendingInboundStasisChannel({
    ...inboundChannel,
    dialplan: { app_name: 'Stasis', app_data: 'openclaw,outbound-call' },
  }, 'openclaw'), false);
  assert.equal(isPendingInboundStasisChannel({
    ...inboundChannel,
    dialplan: { app_name: 'Dial', app_data: 'openclaw,inbound-realtime' },
  }, 'openclaw'), false);
});

test('reconciliation admits each matching channel once and does not take media actions', async () => {
  const admitted = [];
  const result = await reconcileInboundChannels([
    inboundChannel,
    { ...inboundChannel, id: 'PJSIP/700-00000002', state: 'Ringing' },
    { ...inboundChannel, id: 'PJSIP/700-00000003', state: 'Up' },
  ], {
    ariApp: 'openclaw',
    hasAdmissionForChannel: (channelId) => channelId === 'PJSIP/700-00000002',
    admit: async (channel) => admitted.push(channel.id),
  });

  assert.deepEqual(admitted, ['PJSIP/700-00000001']);
  assert.deepEqual(result, { scanned: 3, candidates: 2, admitted: 1, skipped: 1 });
});
