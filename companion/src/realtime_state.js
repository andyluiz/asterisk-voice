import { randomUUID } from 'node:crypto';

function canSendResponse(state) {
  return state.sessionConfigured
    && !state.responseInFlight
    && (!state.pendingLanguageSync || state.pendingLanguageSync.sessionUpdated);
}

function flushQueuedResponses(state) {
  if (!canSendResponse(state) || state.queuedResponses.length === 0) return [];
  const next = state.queuedResponses.shift();
  state.responseInFlight = true;
  return [next];
}

export function createRealtimeResponseState(idFactory = () => randomUUID().replaceAll('-', '')) {
  return {
    idFactory,
    initialSessionUpdatePending: true,
    sessionConfigured: false,
    responseInFlight: false,
    queuedResponses: [],
    pendingLanguageSync: null,
    outputAudioStarted: false,
  };
}

export function beginLanguageSync(state, language) {
  const sync = {
    language,
    itemId: state.idFactory(),
    sessionUpdated: false,
    systemItemCreated: false,
  };
  state.pendingLanguageSync = sync;
  return sync;
}

export function buildLanguageSyncItem(sync) {
  return {
    type: 'conversation.item.create',
    item: {
      id: sync.itemId,
      type: 'message',
      role: 'system',
      content: [{
        type: 'input_text',
        text: `The callee is now speaking ${sync.language}. After any fixed opening script already required by the brief, all future assistant responses must stay in ${sync.language} until a later clear language change.`,
      }],
    },
  };
}

export function requestResponse(state, response, reason, { queueIfBlocked = false } = {}) {
  if (!canSendResponse(state)) {
    if (!queueIfBlocked) return { sent: false, queued: false, reason };
    state.queuedResponses.push({ response, reason });
    return { sent: false, queued: true, reason };
  }
  state.responseInFlight = true;
  return { sent: true, queued: false, reason, payload: { response, reason } };
}

export function acknowledgeSessionUpdated(state) {
  if (state.initialSessionUpdatePending) {
    state.initialSessionUpdatePending = false;
    state.sessionConfigured = true;
    return { type: 'initial-session-configured', flushed: flushQueuedResponses(state) };
  }
  if (!state.pendingLanguageSync) return { type: 'session-updated', flushed: [] };
  state.pendingLanguageSync.sessionUpdated = true;
  const flushed = flushQueuedResponses(state);
  return { type: 'language-session-updated', language: state.pendingLanguageSync.language, flushed };
}

export function acknowledgeConversationItemCreated(state, itemId) {
  if (!state.pendingLanguageSync || state.pendingLanguageSync.itemId !== itemId) {
    return { matched: false, flushed: [] };
  }
  state.pendingLanguageSync.systemItemCreated = true;
  const flushed = flushQueuedResponses(state);
  return { matched: true, language: state.pendingLanguageSync.language, flushed };
}

export function completeLanguageSyncIfReady(state) {
  if (!state.pendingLanguageSync) return null;
  if (!state.pendingLanguageSync.sessionUpdated || !state.pendingLanguageSync.systemItemCreated) return null;
  const language = state.pendingLanguageSync.language;
  state.pendingLanguageSync = null;
  return language;
}

export function markResponseDone(state) {
  state.responseInFlight = false;
  return flushQueuedResponses(state);
}

export function markOutputAudioStarted(state) {
  state.outputAudioStarted = true;
}
