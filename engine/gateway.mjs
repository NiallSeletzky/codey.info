// Engine-side client for the proposed phpBB extension contract. No core-table access.
export class GatewayError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
  }
}

export function createGateway({ baseUrl, token, timeoutMs = 5000, allowLocalHttp = false }) {
  const base = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash ||
      !(base.protocol === 'https:' || (allowLocalHttp && local && base.protocol === 'http:'))) {
    throw new Error('Gateway requires HTTPS (loopback HTTP only for explicit local tests)');
  }
  if (typeof token !== 'string' || token.length < 24 || /\s/.test(token)) {
    throw new Error('A dedicated worker credential is required');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new Error('Invalid gateway timeout');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';

  async function request(route, payload) {
    try {
      const response = await fetch(new URL(route, base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GatewayError('gateway_rejected', response.status);
      }
      if (!response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel();
        throw new GatewayError('invalid_gateway_response');
      }
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 65536) {
          await reader.cancel();
          throw new GatewayError('gateway_response_too_large');
        }
        chunks.push(Buffer.from(value));
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new GatewayError('invalid_gateway_response');
      }
      return result;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      // Never include credentials, server error bodies, request URLs or prompts in errors.
      throw new GatewayError('gateway_unavailable_or_invalid');
    }
  }
  return Object.freeze({
    claim: () => request('claim', {}),
    context: (lease) => request('context', lease),
    reserve: (lease, maximumPence) => request('reserve', { ...lease, maximumPence }),
    publish: (lease, text) => request('publish', { ...lease, text }),
    publication: (lease) => request('publication', lease),
    complete: (lease, result) => request('complete', { ...lease, ...result }),
  });
}
