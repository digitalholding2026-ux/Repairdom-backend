import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiConfig } from './ai.config.js';
import {
  AiDisabledException,
  AiGatewayException,
  AiInvalidResponseException,
  AiUpstreamException,
} from './ai-errors.js';
import { AiGatewayService, parseJsonBody } from './ai-gateway.service.js';

/* IA-1 — socle AI Gateway (fetch global stubé) : configuration,
 * succès/erreurs OpenRouter, réponses structurées, sécurité des secrets.
 * Aucun appel réseau réel, aucun comportement métier touché. */

const FAKE_KEY = 'sk-or-test-UNITKEY1234567890';

function configService(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] };
}

function gateway(values: Record<string, string | undefined> = {}) {
  const config = new AiConfig(
    configService({ AI_ENABLED: 'true', OPENROUTER_API_KEY: FAKE_KEY, ...values }) as never,
  );
  return new AiGatewayService(config);
}

function stubFetchOnce(status: number, payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    })),
  );
}

function stubFetchThrow(error: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw error;
    }),
  );
}

function stubFetchInvalidJson(status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status,
      headers: { get: () => 'application/json' },
      text: async () => {
        throw new SyntaxError('Unexpected token');
      },
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const INPUT = {
  caller: 'TestCaller',
  messages: [{ role: 'user' as const, content: 'Bonjour' }],
};

function openRouterOk(content = 'Réponse de test', usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  return {
    id: 'gen-1',
    model: 'openai/gpt-4o-mini',
    choices: [{ message: { role: 'assistant', content } }],
    usage,
  };
}

describe('configuration', () => {
  it('IA désactivée par défaut → refus propre, aucun fetch', async () => {
    const config = new AiConfig(configService({}) as never);
    expect(config.enabled).toBe(false);
    expect(config.isConfigured()).toBe(false);
    const service = new AiGatewayService(config);
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(service.complete(INPUT)).rejects.toBeInstanceOf(AiDisabledException);
    expect(spy).not.toHaveBeenCalled();
  });

  it('clé absente malgré AI_ENABLED=true → refus propre', async () => {
    const service = gateway({ OPENROUTER_API_KEY: undefined });
    await expect(service.complete(INPUT)).rejects.toMatchObject({
      name: 'AiDisabledException',
      retryable: false,
    });
  });

  it('URL non-https → refus propre', async () => {
    const service = gateway({ OPENROUTER_BASE_URL: 'http://evil.test/v1' });
    await expect(service.complete(INPUT)).rejects.toBeInstanceOf(AiDisabledException);
  });

  it('défauts sains : modèle, base https, timeout borné, fallback lu', () => {
    const config = new AiConfig(configService({ AI_ENABLED: 'true', OPENROUTER_API_KEY: FAKE_KEY }) as never);
    expect(config.model).toBe('openai/gpt-4o-mini');
    expect(config.validatedBaseUrl()).toBe('https://openrouter.ai/api/v1');
    expect(config.timeoutMs).toBe(30_000);
    expect(config.fallbackModel).toBeNull();
    expect(config.isConfigured()).toBe(true);
    const custom = new AiConfig(
      configService({
        AI_ENABLED: 'true',
        OPENROUTER_API_KEY: FAKE_KEY,
        OPENROUTER_MODEL: 'anthropic/claude-3-haiku',
        OPENROUTER_FALLBACK_MODEL: 'openai/gpt-4o-mini',
        OPENROUTER_TIMEOUT_MS: '5000',
      }) as never,
    );
    expect(custom.model).toBe('anthropic/claude-3-haiku');
    expect(custom.fallbackModel).toBe('openai/gpt-4o-mini');
    expect(custom.timeoutMs).toBe(5000);
  });
});

describe('OpenRouter', () => {
  it('appel réussi → structure interne propre (result/model/usage/duration)', async () => {
    stubFetchOnce(200, openRouterOk());
    const result = await gateway().complete(INPUT);
    expect(result.result).toBe('Réponse de test');
    expect(result.model).toBe('openai/gpt-4o-mini');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('timeout réseau → AiUpstreamException rejouable', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    stubFetchThrow(timeout);
    await expect(gateway().complete(INPUT)).rejects.toMatchObject({
      name: 'AiUpstreamException',
      retryable: true,
    });
  });

  it('panne réseau → AiUpstreamException rejouable', async () => {
    stubFetchThrow(new TypeError('fetch failed'));
    await expect(gateway().complete(INPUT)).rejects.toBeInstanceOf(AiUpstreamException);
  });

  it('HTTP 401/429 → AiTerminalException non rejouable', async () => {
    stubFetchOnce(401, { error: { message: 'Invalid key', code: 401 } });
    await expect(gateway().complete(INPUT)).rejects.toMatchObject({
      name: 'AiTerminalException',
      retryable: false,
      httpStatus: 401,
    });
  });

  it('HTTP 500/503 → AiUpstreamException rejouable', async () => {
    stubFetchOnce(503, { error: { message: 'Overloaded' } });
    await expect(gateway().complete(INPUT)).rejects.toMatchObject({
      name: 'AiUpstreamException',
      retryable: true,
      httpStatus: 503,
    });
  });

  it('JSON illisible → AiInvalidResponseException', async () => {
    stubFetchInvalidJson();
    await expect(gateway().complete(INPUT)).rejects.toBeInstanceOf(AiInvalidResponseException);
  });

  it('200 sans contenu exploitable → AiInvalidResponseException', async () => {
    stubFetchOnce(200, { choices: [] });
    await expect(gateway().complete(INPUT)).rejects.toBeInstanceOf(AiInvalidResponseException);
    stubFetchOnce(200, { unexpected: true });
    await expect(gateway().complete(INPUT)).rejects.toBeInstanceOf(AiInvalidResponseException);
  });

  it('réponse structurée valide → completeJson parsé', async () => {
    stubFetchOnce(200, openRouterOk('{"statut":"ok","score":2}'));
    const result = await gateway().completeJson<{ statut: string; score: number }>(INPUT);
    expect(result.result).toEqual({ statut: 'ok', score: 2 });
    expect(result.model).toBe('openai/gpt-4o-mini');
  });

  it('bloc markdown ```json toléré, non-JSON → erreur propre', async () => {
    stubFetchOnce(200, openRouterOk('```json\n{"a":1}\n```'));
    const result = await gateway().completeJson<{ a: number }>(INPUT);
    expect(result.result).toEqual({ a: 1 });
    stubFetchOnce(200, openRouterOk('pas du json'));
    await expect(gateway().completeJson(INPUT)).rejects.toBeInstanceOf(AiInvalidResponseException);
  });
});

describe('parseJsonBody', () => {
  it('JSON brut, bloc markdown, invalide', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonBody('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonBody('  [1,2]  ')).toEqual([1, 2]);
    expect(parseJsonBody('')).toBeUndefined();
    expect(parseJsonBody('nope')).toBeUndefined();
  });
});

describe('sécurité des secrets', () => {
  it('la clé ne fuit ni dans les erreurs ni dans les résultats', async () => {
    stubFetchOnce(401, { error: { message: FAKE_KEY } });
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AiGatewayException);
    expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
    expect(String((error as Error).message)).not.toContain(FAKE_KEY);

    stubFetchOnce(200, openRouterOk());
    const result = await gateway().complete(INPUT);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it('la clé ne fuite pas dans les logs stdout', async () => {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as never);
    try {
      stubFetchOnce(200, openRouterOk());
      await gateway().complete({ ...INPUT, correlationId: 'corr-1' });
      stubFetchOnce(500, { error: 'boom' });
      await gateway().complete(INPUT).catch(() => undefined);
    } finally {
      spy.mockRestore();
      void originalWrite;
    }
    expect(chunks.join('')).not.toContain(FAKE_KEY);
    expect(chunks.join('')).not.toContain('sk-or-test');
  });

  it('Authorization expurgée même si interpolée par mégarde', async () => {
    stubFetchOnce(401, { error: { message: `Authorization: Bearer ${FAKE_KEY}` } });
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(String((error as Error).message)).not.toContain(FAKE_KEY);
  });
});

describe('robustesse', () => {
  it('toute exception OpenRouter devient une AiGatewayException', async () => {
    stubFetchThrow(new Error('socket hang up'));
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AiGatewayException);
    expect(typeof (error as AiGatewayException).code).toBe('string');
    expect(typeof (error as AiGatewayException).retryable).toBe('boolean');
  });
});
