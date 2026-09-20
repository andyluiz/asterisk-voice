const DEFAULT_ARI_TIMEOUT_MS = 5_000;

function timeoutError(path, method, cause) {
  const error = new Error(`ARI ${method} ${path} timed out`);
  error.code = 'ARI_TIMEOUT';
  error.status = 504;
  error.cause = cause;
  return error;
}

export function createAriRequest({
  ariUrl,
  ariUsername,
  ariPassword,
  timeoutMs = DEFAULT_ARI_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  if (!ariUrl) throw new Error('ariUrl is required');

  return async function ariRequest(path, options = {}) {
    const method = options.method ?? 'GET';
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const url = new URL(path.replace(/^\/+/, ''), `${ariUrl.replace(/\/+$/, '')}/`).toString();

    try {
      const response = await fetchImpl(url, {
        ...options,
        signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${ariUsername}:${ariPassword}`).toString('base64')}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      });
      const text = await response.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (!response.ok) {
        const error = new Error(`ARI ${method} ${path} failed: ${response.status}`);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    } catch (error) {
      if (timeoutSignal.aborted) throw timeoutError(path, method, error);
      throw error;
    }
  };
}
