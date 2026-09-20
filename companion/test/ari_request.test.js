import assert from 'node:assert/strict';
import test from 'node:test';

import { createAriRequest } from '../src/ari_request.js';

test('ARI requests abort within the configured deadline instead of blocking cleanup forever', async () => {
  const ariRequest = createAriRequest({
    ariUrl: 'http://asterisk.invalid/ari',
    ariUsername: 'test-user',
    ariPassword: 'test-password',
    timeoutMs: 15,
    fetchImpl: (_url, options) => new Promise((_, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('request was not aborted')), 100);
      options.signal.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(options.signal.reason);
      }, { once: true });
    }),
  });

  await assert.rejects(
    ariRequest('/channels/caller', { method: 'DELETE' }),
    (error) => error.code === 'ARI_TIMEOUT' && error.status === 504,
  );
});

test('a failed channel deletion does not prevent later cleanup operations', async () => {
  const requests = [];
  const ariRequest = createAriRequest({
    ariUrl: 'http://asterisk.invalid/ari',
    ariUsername: 'test-user',
    ariPassword: 'test-password',
    timeoutMs: 15,
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.endsWith('/channels/primary')) throw new Error('socket failure');
      return new Response('', { status: 204 });
    },
  });

  for (const channel of ['primary', 'external']) {
    try {
      await ariRequest(`/channels/${channel}`, { method: 'DELETE' });
    } catch {}
  }

  assert.deepEqual(requests.map((url) => new URL(url).pathname), [
    '/ari/channels/primary',
    '/ari/channels/external',
  ]);
});
