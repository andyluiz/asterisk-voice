import test from 'node:test';
import assert from 'node:assert/strict';
import { appendConversationTurn, formatRecentConversation } from '../src/conversation_context.js';

test('handoff context preserves caller and assistant turn order', () => {
  let turns = [];
  turns = appendConversationTurn(turns, 'caller', 'Verifica com o Raul qual que é a placa do carro Corolla.');
  turns = appendConversationTurn(turns, 'assistant', 'Eu não consigo consultar placas.');
  turns = appendConversationTurn(turns, 'caller', 'Não, você está com a Wiki. Faça isso, por favor.');

  assert.equal(formatRecentConversation(turns), [
    'Conversation context (chronological):',
    'Caller: Verifica com o Raul qual que é a placa do carro Corolla.',
    'Hal: Eu não consigo consultar placas.',
    'Caller: Não, você está com a Wiki. Faça isso, por favor.',
  ].join('\n'));
});

test('handoff context is bounded to recent turns', () => {
  let turns = [];
  for (let index = 1; index <= 10; index += 1) turns = appendConversationTurn(turns, 'caller', `turn ${index}`);
  const context = formatRecentConversation(turns);
  assert.doesNotMatch(context, /turn 1\n/);
  assert.match(context, /Caller: turn 3/);
  assert.match(context, /Caller: turn 10/);
});
