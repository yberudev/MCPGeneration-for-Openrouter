import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { OpenRouterClient } from '../../src/providers/openrouter/client.js';
import { getTransportDiagnostic } from '../../src/providers/openrouter/diagnostics.js';

function client(fetchImpl: typeof fetch, timeoutMs = 1_000): OpenRouterClient {
  return new OpenRouterClient({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-test-do-not-log',
    timeoutMs,
    fetchImpl,
  });
}

function codedError(code: string, name = 'Error'): Error {
  const error = new Error('sensitive prompt and Bearer sk-or-test-do-not-log') as Error & { code: string };
  error.name = name;
  error.code = code;
  return error;
}

describe('OpenRouter network diagnostics', () => {
  it.each([
    ['ENOTFOUND', 'dns', 'dns', false, undefined],
    ['EAI_AGAIN', 'dns', 'dns', false, undefined],
    ['ECONNRESET', 'request_or_waiting_for_headers', 'tcp', false, undefined],
    ['ECONNREFUSED', 'tcp_connect', 'tcp', false, undefined],
    ['UND_ERR_CONNECT_TIMEOUT', 'tcp_connect', 'tcp', true, 'connect'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_handshake', 'tls', false, undefined],
  ] as const)('preserves safe cause metadata for %s', async (code, phase, layer, timedOut, timeoutKind) => {
    const underlying = codedError(code);
    const fetchFailure = new TypeError('fetch failed', { cause: underlying });
    const openRouter = client(async () => {
      throw fetchFailure;
    });

    const error = await openRouter.listVideoModels().catch((caught: unknown) => caught);
    const diagnostic = getTransportDiagnostic(error);
    expect(diagnostic).toMatchObject({
      phase,
      transport_layer: layer,
      timed_out: timedOut,
      error_codes: [code],
    });
    expect(diagnostic?.duration_ms).toBeGreaterThanOrEqual(0);
    if (timeoutKind) expect(diagnostic?.timeout_kind).toBe(timeoutKind);
    const serialized = JSON.stringify({ error: String(error), diagnostic });
    expect(serialized).not.toContain('sensitive prompt');
    expect(serialized).not.toContain('sk-or-test-do-not-log');
  });

  it('distinguishes an actual request timeout from an immediate network failure', async () => {
    const openRouter = client(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
      10,
    );
    const error = await openRouter.listVideoModels().catch((caught: unknown) => caught);
    expect(getTransportDiagnostic(error)).toMatchObject({ outcome: 'timeout', timed_out: true });
  });

  it('classifies a socket reset while reading response bytes', async () => {
    const bodyError = new TypeError('sensitive body data', { cause: codedError('ECONNRESET') });
    const openRouter = client(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(bodyError);
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const error = await openRouter.listVideoModels().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'RESPONSE_READ_ERROR' });
    expect(getTransportDiagnostic(error)).toMatchObject({
      phase: 'response_body',
      outcome: 'response_read_error',
      error_codes: ['ECONNRESET'],
    });
    expect(String(error)).not.toContain('sensitive body data');
  });

  it('blocks redirects without following or forwarding credentials to the Location host', async () => {
    let calls = 0;
    let callbackStatus: number | undefined;
    const openRouter = client(async (_input, init) => {
      calls += 1;
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-or-test-do-not-log');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/collect' },
      });
    });
    const error = await openRouter
      .generateImageWithStatus({ model: 'test/image', prompt: 'private prompt' }, (status) => {
        callbackStatus = status;
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'REDIRECT_BLOCKED' });
    expect(getTransportDiagnostic(error)).toMatchObject({ phase: 'redirect', outcome: 'redirect_blocked' });
    expect(callbackStatus).toBe(302);
    expect(calls).toBe(1);
    expect(String(error)).not.toContain('attacker.example');
    expect(String(error)).not.toContain('private prompt');
  });

  it('confirms native redirect:error becomes a generic fetch failure without an HTTP status', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: 'https://attacker.example/collect' });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing ephemeral server address');
      const error = await fetch(`http://127.0.0.1:${address.port}/`, { redirect: 'error' }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ message: 'fetch failed' });
      expect((error as Error & { cause?: Error }).cause?.message).toBe('unexpected redirect');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('runs free authenticated GET and unauthenticated invalid POST probes without printing secrets', async () => {
    const requests: Array<{ method: string; authorization: string | null; body: string | null }> = [];
    const openRouter = client(async (input, init) => {
      requests.push({
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (new URL(String(input)).pathname.endsWith('/key')) {
        return Response.json({ data: { label: 'sk-or-response-secret', usage: 99 } });
      }
      return Response.json({ error: 'missing model/messages' }, { status: 400 });
    });

    const result = await openRouter.diagnoseNetwork();
    expect(result.map((probe) => probe.http_status)).toEqual([200, 400]);
    expect(result.every((probe) => probe.http_reachable)).toBe(true);
    expect(requests).toEqual([
      { method: 'GET', authorization: 'Bearer sk-or-test-do-not-log', body: null },
      { method: 'POST', authorization: null, body: '{}' },
    ]);
    expect(JSON.stringify(result)).not.toContain('sk-or');
  });

  it('does not retry paid POSTs when fetch fails', async () => {
    let calls = 0;
    const openRouter = client(async () => {
      calls += 1;
      throw new TypeError('fetch failed', { cause: codedError('ECONNRESET') });
    });
    await expect(openRouter.generateImage({ model: 'test/image', prompt: 'x' })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(calls).toBe(1);
  });
});
