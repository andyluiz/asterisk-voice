import { randomUUID } from 'node:crypto';

function localExtension(value) {
  const raw = String(value ?? '').trim();
  if (/^\d+$/.test(raw)) return raw;
  const local = raw.match(/^local:(\d+)$/i);
  if (local) return local[1];
  const pjsip = raw.match(/^PJSIP\/(\d+)$/i);
  if (pjsip) return pjsip[1];
  const localChannel = raw.match(/^Local\/(\d+)@internal$/i);
  if (localChannel) return localChannel[1];
  return null;
}

export function validateLocalEndpoint(target, allowlistedExtensions, dialplanExtensions = new Set()) {
  const extension = localExtension(target);
  if (!extension || !allowlistedExtensions.has(extension)) {
    throw new Error('Target is not allowlisted for local-only calling');
  }
  return String(target).toLowerCase().startsWith('local:')
    || String(target).startsWith('Local/')
    || dialplanExtensions.has(extension)
    ? `Local/${extension}@internal`
    : `PJSIP/${extension}`;
}

function normalizeBrief(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Call brief must be an object');
  }
  const json = JSON.stringify(value);
  if (json.length > 6000) throw new Error('Call brief is too large');
  const text = (key, limit = 800) => {
    if (value[key] == null) return null;
    if (typeof value[key] !== 'string') throw new Error(`Call brief field ${key} must be a string`);
    return value[key].trim().slice(0, limit) || null;
  };
  const mission = text('mission', 4000);
  const completionBehavior = value.completion_behavior ?? 'callee_request_only';
  if (!['callee_request_only', 'end_after_callee_confirmation'].includes(completionBehavior)) {
    throw new Error('Call brief completion_behavior is invalid');
  }
  const interactionMode = value.interaction_mode ?? 'outbound_mission';
  if (!['outbound_mission', 'hermes_voice'].includes(interactionMode)) {
    throw new Error('Call brief interaction_mode is invalid');
  }
  return Object.freeze({
    mission,
    simulation: value.simulation === true,
    preferred_language: text('preferred_language', 48),
    adapt_language: value.adapt_language !== false,
    completion_behavior: completionBehavior,
    interaction_mode: interactionMode,
    voice_context: text('voice_context', 3000),
  });
}

export function createPreparedCall(request, allowlistedExtensions, dialplanExtensions = new Set()) {
  const endpoint = validateLocalEndpoint(request.to ?? request.endpoint, allowlistedExtensions, dialplanExtensions);
  return {
    id: request.callId || randomUUID(),
    endpoint,
    requestedTo: request.to ?? request.endpoint,
    purpose: String(request.purpose ?? '').trim(),
    brief: normalizeBrief(request.brief),
    status: 'prepared',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  };
}

export function requireApprovedStart(call, request) {
  if (call.status !== 'prepared') throw new Error(`Call cannot start from state ${call.status}`);
  if (request?.approved !== true) {
    const error = new Error('Call start requires explicit approval');
    error.status = 409;
    throw error;
  }
  return { ...call, status: 'approved', updatedAt: new Date().toISOString() };
}
