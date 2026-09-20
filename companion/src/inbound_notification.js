import { createHmac } from 'node:crypto';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Delivery carries only the opaque admission request—not caller numbers, SIP/ARI
// IDs, or caller-provided display names. The same X-Request-ID is reused on retry
// so Hermes' webhook idempotency cache starts at most one decision agent run.
export async function notifyInboundAdmission(request, webhook, {
  fetchFn = fetch,
  now = () => Date.now(),
  sleep = wait,
} = {}) {
  if (!webhook) return { delivered: false, skipped: 'not_configured' };
  const payload = JSON.stringify({ event_type: 'inbound_admission_requested', admission: request });
  const deliveryId = `inbound-admission-${request.sessionId}`;
  let lastError = null;

  for (let attempt = 0; attempt <= webhook.retryCount; attempt += 1) {
    const timestamp = String(Math.floor(now() / 1000));
    const signature = createHmac('sha256', webhook.secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), webhook.timeoutMs);
    try {
      const response = await fetchFn(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature-V2': signature,
          'X-Webhook-Timestamp': timestamp,
          'X-Request-ID': deliveryId,
        },
        body: payload,
        signal: controller.signal,
      });
      if (response.status >= 200 && response.status < 300) {
        return { delivered: true, status: response.status, attempts: attempt + 1, deliveryId };
      }
      lastError = new Error(`Hermes webhook returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < webhook.retryCount) await sleep(webhook.retryDelayMs * (2 ** attempt));
  }
  return { delivered: false, attempts: webhook.retryCount + 1, deliveryId, error: lastError?.message ?? 'delivery failed' };
}
