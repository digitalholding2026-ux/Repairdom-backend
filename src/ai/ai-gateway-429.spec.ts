import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { AiConfig } from './ai.config.js';
import {
  AiGatewayService,
  MAX_429_RETRY_AFTER_MS,
  resolveRetryDelayMs,
} from './ai-gateway.service.js';
import { AiTerminalException, AiUpstreamException } from './ai-errors.js';

/* IA-11.4 — résilience HTTP 429 OpenRouter : 1 retry max par appel, backoff
 * court (Retry-After borné préféré), AUCUNE boucle, AUCUN retry sur les
 * autres erreurs, fail-open inchangé. Logs = métadonnées seules. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CONFIG_VALUES: Record<string, string> = {
  AI_ENABLED: 'true',
  OPENROUTER_API_KEY: 'sk-or-test-UNIT',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
};

function configWith(values: Record<string, string | undefined> = {}) {
  return new AiConfig({ get: (key: string) => ({ ...CONFIG_VALUES, ...values })[key] } as never);
}

function gatewayWith(values: Record<string, string | undefined> = {}) {
  return new AiGatewayService(configWith(values));
}

const INPUT = { caller: 'RetryTest', messages: [{ role: 'user' as const, content: 'Bonjour' }] };

interface Step {
  status: number;
  payload?: unknown;
  retryAfter?: string;
}

/** fetch simulée séquentielle + compteur d'appels. */
function stubSteps(steps: Step[]) {
  let calls = 0;
  const fetchMock = vi.fn(async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls += 1;
    return {
      status: step.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'retry-after' ? (step.retryAfter ?? null) : 'application/json',
      },
      text: async () => JSON.stringify(step.payload ?? {}),
      json: async () => step.payload ?? {},
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, callCount: () => fetchMock.mock.calls.length };
}

function okStep(content: string): Step {
  return {
    status: 200,
    payload: { choices: [{ message: { content }, finish_reason: 'stop' }], model: 'm' },
  };
}

function captureOutput() {
  const logs: string[] = [];
  const warns: string[] = [];
  vi.spyOn(Logger.prototype, 'log').mockImplementation(((message: unknown) => {
    logs.push(String(message));
  }) as never);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(((message: unknown) => {
    warns.push(String(message));
  }) as never);
  return { logs, warns };
}

describe('configuration retry 429', () => {
  it('défauts : maxRetries=1, retryDelayMs=1000', () => {
    const config = configWith({});
    expect(config.rateLimitMaxRetries).toBe(1);
    expect(config.rateLimitRetryDelayMs).toBe(1000);
  });

  it('surcharges bornées (aucune boucle possible)', () => {
    expect(configWith({ AI_429_MAX_RETRIES: '0' }).rateLimitMaxRetries).toBe(0);
    expect(configWith({ AI_429_MAX_RETRIES: '5' }).rateLimitMaxRetries).toBe(1);
    expect(configWith({ AI_429_MAX_RETRIES: '-3' }).rateLimitMaxRetries).toBe(0);
    expect(configWith({ AI_429_MAX_RETRIES: 'nawak' }).rateLimitMaxRetries).toBe(1);
    expect(configWith({ AI_429_RETRY_DELAY_MS: '250' }).rateLimitRetryDelayMs).toBe(250);
    expect(configWith({ AI_429_RETRY_DELAY_MS: '99999' }).rateLimitRetryDelayMs).toBe(10_000);
    expect(configWith({ AI_429_RETRY_DELAY_MS: '-5' }).rateLimitRetryDelayMs).toBe(0);
    expect(configWith({ AI_429_RETRY_DELAY_MS: 'nawak' }).rateLimitRetryDelayMs).toBe(1000);
  });
});

describe('resolveRetryDelayMs — pur, sans réseau ni attente', () => {
  it('secondes valides → ms', () => {
    expect(resolveRetryDelayMs('2', 1000)).toBe(2000);
    expect(resolveRetryDelayMs('0', 1000)).toBe(0);
  });

  it('valeur excessive → plafond 10 s', () => {
    expect(resolveRetryDelayMs('3600', 1000)).toBe(MAX_429_RETRY_AFTER_MS);
    expect(MAX_429_RETRY_AFTER_MS).toBe(10_000);
  });

  it('date HTTP future/présente → délai borné, passée → 0', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    expect(resolveRetryDelayMs(future, 1000)).toBe(MAX_429_RETRY_AFTER_MS);
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(resolveRetryDelayMs(past, 1000)).toBe(0);
  });

  it('absent/invalide → backoff configuré', () => {
    expect(resolveRetryDelayMs(null, 1000)).toBe(1000);
    expect(resolveRetryDelayMs('nawak', 1000)).toBe(1000);
    expect(resolveRetryDelayMs('   ', 1000)).toBe(1000);
    expect(resolveRetryDelayMs('-2', 1000)).toBe(1000);
  });
});

describe('Cas 1 — 429 puis succès : retry unique, succès final', () => {
  it('exactement 2 appels, backoff 1 s, succès', async () => {
    const { warns } = captureOutput();
    const { callCount } = stubSteps([{ status: 429, payload: { error: 'rate limited' } }, okStep('{"a":1}')]);
    const startedAt = Date.now();
    const result = await gatewayWith().completeJson<{ a: number }>(INPUT);
    const elapsed = Date.now() - startedAt;
    expect(result.result).toEqual({ a: 1 });
    expect(callCount()).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(800);
    const joined = warns.join('\n');
    expect(joined).toContain('AI 429 retry');
    expect(joined).toContain('attempt=2');
    expect(joined).toContain('delayMs=1000');
    expect(joined).not.toContain('AI 429 exhausted');
  });
});

describe('Cas 2 — 429 puis 429 : échec propre, aucun troisième appel', () => {
  it('exactement 2 appels, upstream_rate_limited, fail-open', async () => {
    const { warns } = captureOutput();
    const { callCount } = stubSteps([
      { status: 429, payload: { error: 'slow down' } },
      { status: 429, payload: { error: 'slow down' } },
      okStep('{"a":1}'),
    ]);
    const error = await gatewayWith().completeJson(INPUT).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AiUpstreamException);
    expect(error).toMatchObject({ httpStatus: 429, transportReason: 'upstream_rate_limited', retryable: true });
    expect(callCount()).toBe(2);
    const joined = warns.join('\n');
    expect(joined).toContain('AI 429 retry');
    expect(joined).toContain('AI 429 exhausted');
    expect(joined).toContain('attempts=2');
  });

  it('maxRetries=0 → 429 immédiat, 1 seul appel, aucune attente', async () => {
    const { warns } = captureOutput();
    const { callCount } = stubSteps([{ status: 429, payload: {} }]);
    const startedAt = Date.now();
    const error = await gatewayWith({ AI_429_MAX_RETRIES: '0' }).complete(INPUT).catch((err: unknown) => err);
    expect(Date.now() - startedAt).toBeLessThan(800);
    expect(error).toMatchObject({ transportReason: 'upstream_rate_limited' });
    expect(callCount()).toBe(1);
    expect(warns.join('\n')).not.toContain('AI 429 retry');
  });
});

describe('Cas 4/5/6 — aucun retry hors 429', () => {
  it('Cas 4 — 400 → terminal, 1 appel', async () => {
    const { warns } = captureOutput();
    const { callCount } = stubSteps([{ status: 400, payload: { error: 'bad request' } }]);
    const error = await gatewayWith().complete(INPUT).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AiTerminalException);
    expect(callCount()).toBe(1);
    expect(warns.join('\n')).not.toContain('AI 429 retry');
  });

  it('401/403/404/422 → aucun retry', async () => {
    for (const status of [401, 403, 404, 422]) {
      const { callCount } = stubSteps([{ status, payload: { error: 'refused' } }]);
      const error = await gatewayWith().complete(INPUT).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(AiTerminalException);
      expect(callCount()).toBe(1);
    }
  });

  it('500 → upstream, 1 appel (pas de retry 5xx)', async () => {
    const { callCount } = stubSteps([{ status: 500, payload: { error: 'boom' } }]);
    const error = await gatewayWith().complete(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({ transportReason: 'upstream_server_error' });
    expect(callCount()).toBe(1);
  });

  it('Cas 5 — timeout fetch → 1 appel, aucun retry', async () => {
    const { warns } = captureOutput();
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const fetchMock = vi.fn(async () => {
      throw timeout;
    });
    vi.stubGlobal('fetch', fetchMock);
    const error = await gatewayWith().complete(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({ transportReason: 'request_timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warns.join('\n')).not.toContain('AI 429 retry');
  });

  it('Cas 6 — body_read_error → 1 appel réseau, aucun retry', async () => {
    const { warns } = captureOutput();
    const fetchMock = vi.fn(async () => ({
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => {
        throw new Error('stream reset');
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await gatewayWith().complete(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({ transportReason: 'body_read_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warns.join('\n')).not.toContain('AI 429 retry');
  });

  it('non-JSON 200 → 1 appel, aucun retry', async () => {
    const payload = { choices: [{ message: { content: 'pas du json' }, finish_reason: 'stop' }] };
    const fetchMock = vi.fn(async () => ({
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await gatewayWith().completeJson(INPUT).catch((err: unknown) => err);
    expect(error).toMatchObject({ message: 'Réponse IA non-JSON.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Cas 8 — Retry-After exploité et borné', () => {
  it('Retry-After: 0 → retry immédiat, delayMs=0', async () => {
    const { warns } = captureOutput();
    const { callCount } = stubSteps([
      { status: 429, payload: {}, retryAfter: '0' },
      okStep('{"a":1}'),
    ]);
    const result = await gatewayWith().completeJson<{ a: number }>(INPUT);
    expect(result.result).toEqual({ a: 1 });
    expect(callCount()).toBe(2);
    const joined = warns.join('\n');
    expect(joined).toContain('delayMs=0');
    expect(joined).toContain('delaySource=retry-after');
  });

  it('sans Retry-After → delaySource=default', async () => {
    const { warns } = captureOutput();
    stubSteps([{ status: 429, payload: {} }, okStep('{"a":1}')]);
    await gatewayWith().completeJson(INPUT);
    expect(warns.join('\n')).toContain('delaySource=default');
  });

  it('corrélation conservée sur les lignes retry/exhausted', async () => {
    const { warns } = captureOutput();
    stubSteps([
      { status: 429, payload: {} },
      { status: 429, payload: {} },
    ]);
    await gatewayWith()
      .complete({ ...INPUT, correlationId: 'corr-429-1' })
      .catch(() => undefined);
    const joined = warns.join('\n');
    expect(joined).toContain('correlation=corr-429-1');
  });
});

describe('sécurité — aucun secret/contenu dans les nouveaux logs', () => {
  it('retry + exhausted sans clé, Authorization, prompt ni contenu', async () => {
    const { logs, warns } = captureOutput();
    const promptSentinel = 'PROMPT-SENTINEL-429-Z9Q';
    const contentSentinel = 'CONTENU-SECRET-429-K7M';
    const fetchMock = vi.fn(async () => ({
      status: 429,
      headers: { get: () => 'application/json' },
      text: async () => contentSentinel,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await gatewayWith()
      .complete({ caller: 'RetryTest', messages: [{ role: 'user', content: promptSentinel }] })
      .catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const joined = [...logs, ...warns].join('\n');
    for (const leak of [promptSentinel, contentSentinel, 'sk-or-test-UNIT', 'Bearer', 'Authorization', 'OPENROUTER_API_KEY']) {
      expect(joined).not.toContain(leak);
    }
    expect(joined).toContain('AI 429 retry');
    expect(joined).toContain('AI 429 exhausted');
  });
});
