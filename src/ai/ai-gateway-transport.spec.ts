import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { AiConfig } from './ai.config.js';
import { AiGatewayService } from './ai-gateway.service.js';
import { AiInvalidResponseException, AiUpstreamException } from './ai-errors.js';

/* IA-11.3 — transport HTTP 200 : `request_timeout` vs `body_read_error`
 * (dont avort pendant la lecture, cas prod à ~timeout) vs forme OpenRouter.
 * Métadonnées seules en logs, jamais le corps. Modèle et parser inchangés. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CONFIG_VALUES: Record<string, string> = {
  AI_ENABLED: 'true',
  OPENROUTER_API_KEY: 'sk-or-test-UNIT',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
};

function gateway() {
  return new AiGatewayService(new AiConfig({ get: (key: string) => CONFIG_VALUES[key] } as never));
}

const INPUT = { caller: 'TransportTest', messages: [{ role: 'user' as const, content: 'Bonjour' }] };

function okPayload(content: unknown) {
  return { choices: [{ message: { content }, finish_reason: 'stop' }], model: 'm' };
}

/** Réponse fetch simulée (texte + en-têtes + json, comme l'API réelle). */
function fakeResponse(options: {
  status: number;
  text?: string | (() => Promise<string>);
  contentType?: string;
}) {
  return {
    status: options.status,
    headers: { get: () => options.contentType ?? 'application/json' },
    text:
      typeof options.text === 'function'
        ? options.text
        : async () => options.text ?? '',
    json: async () => JSON.parse(typeof options.text === 'string' ? options.text : '{}') as unknown,
  };
}

function captureWarns() {
  const warns: string[] = [];
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(((message: unknown) => {
    warns.push(String(message));
  }) as never);
  return warns;
}

describe('A. HTTP 200 + JSON normal → succès', () => {
  it('contenu parsé, finishReason propagé, transport nul', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 200, text: JSON.stringify(okPayload('{"a":1}')) })));
    const result = await gateway().completeJson<{ a: number }>(INPUT);
    expect(result.result).toEqual({ a: 1 });
    expect(result.finishReason).toBe('stop');
  });
});

describe('B. HTTP 200 + body vide → invalid_response_body (illisible)', () => {
  it('bodyLength=0, abortReason=none, rien du corps en logs', async () => {
    const warns = captureWarns();
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 200, text: '' })));
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AiInvalidResponseException);
    expect(error).toMatchObject({
      message: 'Réponse IA illisible.',
      transportReason: 'body_read_error',
      abortReason: 'none',
    });
    const line = warns.join('\n');
    expect(line).toContain('body_read_error');
    expect(line).toContain('bodyLength=0');
    expect(line).toContain('abortReason=none');
  });
});

describe('C. HTTP 200 + body illisible (lecture rompue) → body_read_error', () => {
  it('text() rejette hors timeout → abortReason=none', async () => {
    const warns = captureWarns();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          status: 200,
          text: async () => {
            throw new Error('stream reset');
          },
        }),
      ),
    );
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({ transportReason: 'body_read_error', abortReason: 'none' });
    expect(warns.join('\n')).toContain('bodyReadCompleted=false');
  });

  it('avort pendant la lecture (AbortError) → abortReason=timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          status: 200,
          text: async () => {
            const aborted = new Error('The operation was aborted');
            aborted.name = 'AbortError';
            throw aborted;
          },
        }),
      ),
    );
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({ transportReason: 'body_read_error', abortReason: 'timeout' });
  });
});

describe('D. timeout avant réception → request_timeout', () => {
  it('fetch rejette TimeoutError → upstream rejouable, cause timeout', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw timeout;
      }),
    );
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AiUpstreamException);
    expect(error).toMatchObject({ retryable: true, transportReason: 'request_timeout', abortReason: 'timeout' });
  });

  it('fetch pendante + délai réel dépassé → signal avorte (timeout réel)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const timeout = new Error('The operation was aborted due to timeout');
            timeout.name = 'TimeoutError';
            reject(timeout);
          });
        });
      }),
    );
    const error = await gateway()
      .complete({ ...INPUT, timeoutMs: 20 })
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ transportReason: 'request_timeout', abortReason: 'timeout' });
  });

  it('fetch rompue hors timeout → request_network_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({ transportReason: 'request_network_error', abortReason: 'none' });
  });
});

describe('E/F. HTTP 429 / 5xx → upstream classé, sans lecture du corps', () => {
  it('429 → upstream_rate_limited rejouable', async () => {
    const text = vi.fn(async () => '{"error":"rate limited"}');
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 429, headers: { get: () => 'application/json' }, text })));
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({
      name: 'AiUpstreamException',
      retryable: true,
      httpStatus: 429,
      transportReason: 'upstream_rate_limited',
    });
    expect(text).not.toHaveBeenCalled();
  });

  it('500 → upstream_server_error rejouable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 500, text: '{"error":"boom"}' })));
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({ retryable: true, httpStatus: 500, transportReason: 'upstream_server_error' });
  });

  it('401 → terminal provider_refused non rejouable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 401, text: '{"error":"bad key"}' })));
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({ retryable: false, httpStatus: 401, transportReason: 'provider_refused' });
  });
});

describe('G. HTTP 200 + payload OpenRouter invalide → invalid_openrouter_payload', () => {
  it.each([
    ['sans choices', { unexpected: true }],
    ['choices vide', { choices: [] }],
    ['message sans contenu', { choices: [{ message: {} }] }],
    ['contenu vide + stop', { choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] }],
  ])('%s → inexploitable classé', async (_label, payload) => {
    const warns = captureWarns();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ status: 200, text: JSON.stringify(payload) })),
    );
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({ message: 'Réponse IA inexploitable.', transportReason: 'invalid_openrouter_payload' });
    const line = warns.join('\n');
    expect(line).toContain('invalid_openrouter_payload');
    expect(line).toContain('choicesCount=');
  });
});

describe('H/I. contenu textuel et parties → extraction (pas transport)', () => {
  it('texte non-JSON + stop → non-JSON (pas une erreur transport)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ status: 200, text: JSON.stringify(okPayload('Bonjour, voici mon analyse.')) })),
    );
    const error = await gateway().completeJson(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({ message: 'Réponse IA non-JSON.', transportReason: null });
  });

  it('parties [{text}] → concaténées, succès', async () => {
    const payload = {
      choices: [{ message: { content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] }, finish_reason: 'stop' }],
      model: 'm',
    };
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 200, text: JSON.stringify(payload) })));
    const result = await gateway().completeJson<{ a: number }>(INPUT);
    expect(result.result).toEqual({ a: 1 });
  });
});

describe('non-streaming + secrets + timeout centralisé', () => {
  it('aucun `stream:true` envoyé (JSON complet, jamais de flux)', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        if (typeof init?.body === 'string') seen.push(init.body);
        return fakeResponse({ status: 200, text: JSON.stringify(okPayload('{"a":1}')) });
      }),
    );
    await gateway().completeJson(INPUT);
    const body = JSON.parse(seen[0]) as Record<string, unknown>;
    expect(body.stream ?? false).toBe(false);
  });

  it('logs sans corps, sans clé, sans Authorization', async () => {
    const warns = captureWarns();
    const secret = 'CORPS-SECRET-NE-PAS-LOGGER-sk-or-test-UNIT';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ status: 200, text: secret })),
    );
    await gateway().completeJson(INPUT).catch(() => undefined);
    const joined = warns.join('\n');
    expect(joined).not.toContain(secret);
    expect(joined).not.toContain('sk-or-test-UNIT');
    expect(joined).not.toContain('Authorization');
  });

  it('chatTimeoutMs : défaut 12 s, surcharge bornée', () => {
    const config = (values: Record<string, string | undefined>) =>
      new AiConfig({ get: (key: string) => values[key] } as never);
    expect(config({}).chatTimeoutMs).toBe(12_000);
    expect(config({ AI_CHAT_TIMEOUT_MS: '8000' }).chatTimeoutMs).toBe(8000);
    expect(config({ AI_CHAT_TIMEOUT_MS: 'nawak' }).chatTimeoutMs).toBe(12_000);
    expect(config({ AI_CHAT_TIMEOUT_MS: '1' }).chatTimeoutMs).toBe(1000);
    expect(config({ AI_CHAT_TIMEOUT_MS: '999999' }).chatTimeoutMs).toBe(30_000);
  });
});
