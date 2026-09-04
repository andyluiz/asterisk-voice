import { randomUUID } from 'node:crypto';
import { normalizePizzaOrder } from './realtime.js';

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
  const allowedActions = value.allowed_actions == null ? [] : value.allowed_actions;
  if (!Array.isArray(allowedActions) || !allowedActions.every((item) => typeof item === 'string')) {
    throw new Error('Call brief allowed_actions must be an array of strings');
  }
  const task = text('task', 120);
  const pizzaOrder = normalizePizzaOrder(value.pizza_order, task);
  return Object.freeze({
    task,
    simulation: value.simulation === true,
    introduction: text('introduction', 800),
    order_name: text('order_name', 80),
    objective: text('objective'),
    preferred_language: text('preferred_language', 48),
    adapt_language: value.adapt_language !== false,
    constraints: text('constraints', 2000),
    allowed_actions: Object.freeze(allowedActions.map((item) => item.trim()).filter(Boolean).slice(0, 16)),
    requires_final_confirmation: value.requires_final_confirmation !== false,
    ...(pizzaOrder ? { pizza_order: pizzaOrder } : {}),
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
