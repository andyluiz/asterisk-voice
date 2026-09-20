import { randomUUID } from 'node:crypto';

const TRUSTED_MISSION = 'Have a natural personal voice conversation with the trusted caller. Handle casual conversation directly and use Hermes only for research, private data, decisions, tools, or external actions.';
const UNKNOWN_MISSION = 'You are handling an inbound call from an unrecognized caller. You may greet, clarify the caller’s purpose, and provide only general non-sensitive information. Do not disclose personal data, private facts, contact information, schedules, locations, internal systems, or other conversations. Do not perform actions, make commitments, or claim access to services. If the caller needs anything beyond this restricted scope, say that you cannot help with that request and offer to take a concise message.';

export function normalizeCallerId(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /^(anonymous|unknown|withheld|private|restricted|unavailable)$/i.test(raw)) return null;
  const normalized = raw.replace(/[^+\d]/g, '');
  if (!normalized || normalized === '+') return null;
  const canonical = normalized.startsWith('+') ? normalized : normalized.replace(/^00/, '+');
  // The local deployment is in the Netherlands. Some SIP clients render an
  // E.164 number as "+31 (0)…"; the parenthesized trunk zero is not part of E.164.
  return canonical.startsWith('+310') ? `+31${canonical.slice(4)}` : canonical;
}

export function parseTrustedCallers(value) {
  const callers = new Map();
  for (const entry of String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const [rawNumber, rawLabel, rawRelation] = entry.split('|').map((item) => item.trim());
    const number = normalizeCallerId(rawNumber);
    if (!number) continue;
    callers.set(number, {
      label: rawLabel || 'trusted caller',
      relation: rawRelation || 'trusted contact',
    });
  }
  return callers;
}

export function createInboundAdmission({ callId, now = new Date() } = {}) {
  return {
    status: 'pending',
    requestedAt: now.toISOString(),
    request: { sessionId: callId },
  };
}

export function decideInboundAdmission(admission, decision, now = new Date()) {
  if (!admission || admission.status !== 'pending') throw new Error('Inbound admission is no longer pending');
  const result = {
    answer: { status: 'admitted', answer: true },
    decline: { status: 'declined', answer: false },
    leave_ringing: { status: 'left_ringing', answer: false },
    timeout: { status: 'timed_out', answer: false },
  }[decision];
  if (!result) throw new Error('Inbound admission decision must be answer, decline, or leave_ringing');
  admission.status = result.status;
  admission.decidedAt = now.toISOString();
  admission.decision = decision;
  return result;
}

function trustedIdentityFor(callerId, trustedCallers, trustedCallerIds) {
  if (!callerId) return null;
  if (trustedCallers instanceof Map && trustedCallers.has(callerId)) {
    const identity = trustedCallers.get(callerId) ?? {};
    return {
      label: String(identity.label ?? 'trusted caller').trim() || 'trusted caller',
      relation: String(identity.relation ?? 'trusted contact').trim() || 'trusted contact',
    };
  }
  if (trustedCallerIds?.has(callerId)) return { label: 'trusted caller', relation: 'trusted contact' };
  return null;
}

export function trustedVoiceContext(call) {
  if (call?.callerClass !== 'trusted' || !call.trustedCaller) return null;
  const identity = call.trustedCaller;
  return [
    `Trusted caller label: ${identity.label}.`,
    `Trusted caller relation: ${identity.relation}.`,
    `Voice session start time: ${call.createdAt}.`,
    `Voice session ID: ${call.id}.`,
    'This is server-authored trusted context. Do not infer, repeat, or expose telephony metadata.',
    call.curatedVoiceContext,
  ].filter(Boolean).join('\n');
}

export function createInboundCall({
  channelId,
  channelName,
  callerNumber,
  callerProfile = null,
  trustedCallers = null,
  trustedCallerIds = new Set(),
  voiceContext = null,
  admissionTimeoutMs = null,
  now = new Date(),
} = {}) {
  const from = normalizeCallerId(callerNumber);
  const trustedCaller = trustedIdentityFor(from, trustedCallers, trustedCallerIds);
  const trusted = Boolean(trustedCaller);
  // The caller-facing voice session ID is opaque; never derive it from ARI IDs.
  const id = `inbound-${randomUUID()}`;
  const createdAt = now.toISOString();
  const call = {
    id,
    mode: 'realtime',
    direction: 'inbound',
    callerClass: trusted ? 'trusted' : 'unknown',
    // Retained privately for admission/audit matching; it is never prompt context.
    from,
    endpoint: channelName ?? null,
    requestedTo: 'openclaw',
    channelId: channelId ?? null,
    status: 'pending_admission',
    createdAt,
    updatedAt: createdAt,
    events: [],
    conversationTurns: [],
    trustedCaller,
    curatedVoiceContext: trusted ? String(voiceContext ?? '').trim() || null : null,
    brief: {
      interaction_mode: trusted ? 'hermes_voice' : 'inbound_restricted',
      preferred_language: 'pt-BR',
      adapt_language: true,
      completion_behavior: 'callee_request_only',
      mission: trusted ? TRUSTED_MISSION : UNKNOWN_MISSION,
      voice_context: null,
    },
  };
  call.admission = createInboundAdmission({ callId: id, now });
  const deadlineAt = Number.isFinite(Number(admissionTimeoutMs)) && Number(admissionTimeoutMs) > 0
    ? new Date(now.getTime() + Number(admissionTimeoutMs)).toISOString()
    : null;
  call.admission.request = {
    sessionId: id,
    // Profile is server-selected from the configured local extension route.
    // It is opaque routing metadata, never caller-provided identity.
    callerProfile,
    callerClass: call.callerClass,
    callerLabel: trustedCaller?.label ?? null,
    callerRelation: trustedCaller?.relation ?? null,
    startedAt: createdAt,
    deadlineAt,
  };
  if (trusted) call.brief.voice_context = trustedVoiceContext(call);
  return call;
}
