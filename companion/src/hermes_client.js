const DEFAULT_HERMES_PATH = '/internal/voice/handoff';
const MAX_QUESTION_LENGTH = 1000;
const MAX_SAY_LENGTH = 2000;

function text(value, limit) {
  return String(value ?? '').trim().slice(0, limit);
}

function hermesError(message, code, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details !== null) error.details = details;
  return error;
}

function requestUrl(baseUrl, requestPath) {
  return new URL(requestPath, `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

export function normalizeHermesResponse(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw hermesError('Hermes response must be an object', 'HERMES_INVALID_RESPONSE');
  }

  const allowedStatuses = new Set(['completed', 'declined', 'needs_confirmation', 'failed']);
  const status = String(payload.status ?? 'completed').trim();
  if (!allowedStatuses.has(status)) {
    throw hermesError('Hermes response status is invalid', 'HERMES_INVALID_RESPONSE');
  }

  const say = text(payload.say, MAX_SAY_LENGTH);
  if (!say) throw hermesError('Hermes response must include say text', 'HERMES_INVALID_RESPONSE');

  return {
    status,
    say,
    requiresConfirmation: payload.requires_confirmation === true || payload.requiresConfirmation === true,
  };
}

export class HermesClient {
  constructor({
    baseUrl = '',
    token = '',
    path = DEFAULT_HERMES_PATH,
    timeoutMs = 90_000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = String(baseUrl).trim().replace(/\/+$/, '');
    this.token = String(token).trim();
    this.path = String(path || DEFAULT_HERMES_PATH);
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 90_000);
    this.fetchImpl = fetchImpl;
  }

  configured() {
    return Boolean(this.baseUrl && this.token && typeof this.fetchImpl === 'function');
  }

  async request({
    requestId,
    callId,
    profile,
    kind = 'voice_handoff',
    question,
    context = {},
    deadlineAt,
    signal,
  } = {}) {
    if (!this.configured()) {
      throw hermesError('Hermes handoff is not configured', 'HERMES_NOT_CONFIGURED');
    }

    const normalizedQuestion = text(question, MAX_QUESTION_LENGTH);
    if (!normalizedQuestion) {
      throw hermesError('A Hermes question is required', 'HERMES_INVALID_REQUEST');
    }

    const remainingMs = deadlineAt
      ? Math.min(this.timeoutMs, Math.max(1, Date.parse(deadlineAt) - Date.now()))
      : this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let abortListener = null;
    if (signal) {
      abortListener = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', abortListener, { once: true });
    }

    const body = {
      request_id: text(requestId, 128),
      call_id: text(callId, 128),
      profile: text(profile, 128) || 'hal',
      kind: text(kind, 64) || 'voice_handoff',
      question: normalizedQuestion,
      context,
      deadline_at: deadlineAt ?? new Date(Date.now() + remainingMs).toISOString(),
    };

    try {
      const response = await this.fetchImpl(requestUrl(this.baseUrl, this.path), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': body.request_id,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw hermesError(
          `Hermes handoff failed: ${response.status}`,
          'HERMES_HTTP_ERROR',
          { status: response.status, body: responseBody },
        );
      }
      return normalizeHermesResponse(responseBody);
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal?.aborted) throw hermesError('Hermes handoff was cancelled', 'HERMES_CANCELLED');
        throw hermesError('Hermes handoff timed out', 'HERMES_TIMEOUT');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    }
  }
}
