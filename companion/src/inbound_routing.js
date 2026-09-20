const PROFILE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const DISALLOWED_PROFILES = new Set(['default']);

export function normalizeCallerExtension(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /^(anonymous|unknown|withheld|private|restricted|unavailable)$/i.test(raw)) return null;
  // Extensions are local dial strings. Accept harmless formatting only; do not
  // extract digits from SIP URIs, display names, or E.164 caller identity.
  if (!/^[\d\s().-]+$/.test(raw)) return null;
  const normalized = raw.replace(/\D/g, '');
  return normalized || null;
}

function parseRouteTable(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('must be an object');
    return parsed;
  } catch (error) {
    throw new Error(`INBOUND_HERMES_WEBHOOK_ROUTES must be valid JSON: ${error.message}`);
  }
}

function routeFor({ extension, value, env }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.enabled === false) return null;
  const profile = String(value.profile ?? '').trim();
  const url = String(value.url ?? '').trim();
  const secretEnv = String(value.secretEnv ?? '').trim();
  if (!PROFILE_NAME.test(profile) || DISALLOWED_PROFILES.has(profile)) {
    throw new Error(`Inbound webhook route ${extension} has an invalid profile`);
  }
  if (!url || !/^https?:\/\/127\.0\.0\.1(?::\d+)?\//.test(url)) {
    throw new Error(`Inbound webhook route ${extension} must use a loopback HTTP(S) URL`);
  }
  if (!ENV_NAME.test(secretEnv)) {
    throw new Error(`Inbound webhook route ${extension} must name a secret environment variable`);
  }
  const secret = String(env[secretEnv] ?? '');
  // A configured-but-empty secret is intentionally disabled, so templates can
  // carry future routes without activating them.
  if (!secret) return null;
  return Object.freeze({
    extension,
    profile,
    url,
    secret,
    timeoutMs: asPositiveMs(env.INBOUND_HERMES_WEBHOOK_TIMEOUT_MS, 4000),
    retryCount: Math.max(0, Math.floor(Number(env.INBOUND_HERMES_WEBHOOK_RETRIES ?? '2')) || 0),
    retryDelayMs: asPositiveMs(env.INBOUND_HERMES_WEBHOOK_RETRY_DELAY_MS, 250),
  });
}

function asPositiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Returns an authenticated profile-specific route only for a configured local
// extension. There is deliberately no fallback route and `default` is refused.
export function inboundWebhookRouteForCaller(callerNumber, env = process.env) {
  const extension = normalizeCallerExtension(callerNumber);
  if (!extension) return null;
  const table = parseRouteTable(env.INBOUND_HERMES_WEBHOOK_ROUTES);
  return routeFor({ extension, value: table[extension], env });
}
