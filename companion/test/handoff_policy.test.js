import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffPolicy } from '../src/handoff_policy.js';

test('Hermes Voice timeout remains conversational and does not end the call', () => {
  assert.deepEqual(handoffPolicy('hermes_voice'), {
    timeoutMs: 90_000,
    timeoutReply: 'Ainda não consegui verificar isso. Podemos continuar e eu confirmo depois.',
    endAfterTimeout: false,
  });
});

test('outbound mission timeout retains bounded callback behavior', () => {
  assert.deepEqual(handoffPolicy('outbound_mission'), {
    timeoutMs: 20_000,
    timeoutReply: 'Preciso confirmar esse detalhe com Anderson e retorno em breve.',
    endAfterTimeout: true,
  });
});
