import test from 'node:test';
import assert from 'node:assert/strict';
import { callerHandoffTranscript } from '../src/handoff_context.js';

test('handoff uses recent caller words rather than the Realtime-generated question', () => {
  const callerTranscript = [
    'Verifica com o Raul qual que é a placa do carro Corolla.',
    'El panawiki.',
    'Não você está com a Wiki. Faça isso, por favor.',
  ].join('\n');

  assert.equal(callerHandoffTranscript(callerTranscript), [
    'Caller utterances (verbatim, chronological):',
    '1. Verifica com o Raul qual que é a placa do carro Corolla.',
    '2. El panawiki.',
    '3. Não você está com a Wiki. Faça isso, por favor.',
  ].join('\n'));
});

test('handoff rejects a tool call when there is no caller utterance', () => {
  assert.equal(callerHandoffTranscript(''), '');
});
