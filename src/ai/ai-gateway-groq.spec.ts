import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { AiConfig } from './ai.config.js';
import { AiGatewayService } from './ai-gateway.service.js';
import {
  AiDisabledException,
  AiInvalidResponseException,
  AiTerminalException,
  AiUpstreamException,
} from './ai-errors.js';

/* Migration OpenRouter → GroqCloud : contrat du provider vérifié sans
 * appel réseau réel (fetch stubé). Groq expose une API compatible OpenAI
 * (`POST {base}/chat/completions`, Bearer `gsk-…`, `choices[].message`,
 * `finish_reason`, `usage`) : le gateway est inchangé comportementalement.
 * Modèle de production : `openai/gpt-oss-120b`. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FAKE_KEY = 'gsk-test-UNITKEY1234567890';

function configService(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] };
}

function gateway(values: Record<string, string | undefined> = {}) {
  return new AiGatewayService(
    new AiConfig(configService({ AI_ENABLED: 'true', GROQ_API_KEY: FAKE_KEY, ...values }) as never),
  );
}

const INPUT = {
  caller: 'GroqProviderTest',
  messages: [{ role: 'user' as const, content: 'Bonjour' }],
};

/** Payload réaliste GroqCloud (format OpenAI-compatible). */
function groqPayload(content: unknown, finishReason: string | null = 'stop') {
  return {
    id: 'chatcmpl-abc123',
    object: 'chat.completion',
    created: 1727745600,
    model: 'openai/gpt-oss-120b',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
  };
}

function stubFetchOnce(status: number, payload: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async () => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? 'application/json' },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubSequence(steps: Array<{ status: number; payload: unknown; retryAfter?: string }>) {
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
      text: async () => JSON.stringify(step.payload),
      json: async () => step.payload,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function captureLogs() {
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

describe('configuration GroqCloud', () => {
  it('défauts : base Groq, modèle gpt-oss-120b, timeout 30 s, fallback null', () => {
    const config = new AiConfig(configService({ AI_ENABLED: 'true', GROQ_API_KEY: FAKE_KEY }) as never);
    expect(config.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(config.validatedBaseUrl()).toBe('https://api.groq.com/openai/v1');
    expect(config.model).toBe('openai/gpt-oss-120b');
    expect(config.timeoutMs).toBe(30_000);
    expect(config.fallbackModel).toBeNull();
    expect(config.isConfigured()).toBe(true);
  });

  it('AI_ENABLED=false → désactivé, aucun fetch', async () => {
    const service = gateway({ AI_ENABLED: 'false' });
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(service.complete(INPUT)).rejects.toBeInstanceOf(AiDisabledException);
    expect(spy).not.toHaveBeenCalled();
  });

  it('clé absente → refus propre mentionnant Groq (jamais la clé)', async () => {
    const error = await gateway({ GROQ_API_KEY: undefined }).complete(INPUT).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AiDisabledException);
    expect(String((error as Error).message)).toContain('Groq');
    expect(String((error as Error).message)).not.toContain('gsk-');
  });

  it('GROQ_MODEL surcharge le défaut, base non-https refusée', () => {
    const custom = new AiConfig(configService({ GROQ_MODEL: 'llama-3.3-70b-versatile' }) as never);
    expect(custom.model).toBe('llama-3.3-70b-versatile');
    expect(new AiConfig(configService({ GROQ_BASE_URL: 'http://evil.test/v1' }) as never).validatedBaseUrl()).toBeNull();
  });
});

describe('succès Groq — 200/stop/JSON structuré', () => {
  it('JSON valide + usage mappé + finishReason propagé', async () => {
    stubFetchOnce(200, groqPayload('{"tool":"get_technicians","args":{}}'));
    const result = await gateway().completeJson<{ tool: string; args: unknown }>(INPUT);
    expect(result.result).toEqual({ tool: 'get_technicians', args: {} });
    expect(result.model).toBe('openai/gpt-oss-120b');
    expect(result.usage).toEqual({ promptTokens: 42, completionTokens: 17, totalTokens: 59 });
    expect(result.finishReason).toBe('stop');
  });

  it('requête envoyée au format compatible OpenAI (Bearer, pas de stream)', async () => {
    const seen: Array<{ url: unknown; init: { body?: unknown; headers?: unknown } }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init: { body?: unknown; headers?: unknown }) => {
        seen.push({ url, init });
        return {
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify(groqPayload('{"a":1}')),
          json: async () => groqPayload('{"a":1}'),
        };
      }),
    );
    await gateway().completeJson({ ...INPUT, maxTokens: 800 });
    expect(seen).toHaveLength(1);
    expect(String(seen[0].url)).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(String((seen[0].init.body ?? '') as string)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'openai/gpt-oss-120b', max_tokens: 800 });
    expect(body).not.toHaveProperty('stream');
    expect(body).not.toHaveProperty('response_format');
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('logs avec provider=api.groq.com, sans clé ni contenu', async () => {
    const { logs } = captureLogs();
    stubFetchOnce(200, groqPayload('{"a":1}'));
    await gateway().complete(INPUT);
    const joined = logs.join('\n');
    expect(joined).toContain('provider=api.groq.com');
    expect(joined).toContain('model=openai/gpt-oss-120b');
    expect(joined).not.toContain(FAKE_KEY);
    expect(joined).not.toContain('{"a":1}');
  });
});

describe('erreurs Groq — classification inchangée', () => {
  it.each([
    [400, 'AiTerminalException', false],
    [401, 'AiTerminalException', false],
    [403, 'AiTerminalException', false],
  ])('HTTP %s → terminal non rejouable', async (status, name, retryable) => {
    stubFetchOnce(status, { error: { message: 'refused', code: status } });
    await expect(gateway().complete(INPUT)).rejects.toMatchObject({ name, retryable, httpStatus: status });
  });

  it('HTTP 429 → upstream rejouable rate-limited', async () => {
    stubFetchOnce(429, { error: { message: 'Rate limit reached', type: 'rate_limit_error' } });
    await expect(gateway().complete(INPUT)).rejects.toMatchObject({
      name: 'AiUpstreamException',
      retryable: true,
      httpStatus: 429,
    });
  });

  it('HTTP 500 → upstream rejouable', async () => {
    stubFetchOnce(500, { error: { message: 'server error' } });
    await expect(gateway().complete(INPUT)).rejects.toBeInstanceOf(AiUpstreamException);
  });

  it('timeout réseau → upstream timeout, 1 seul appel', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const fetchMock = vi.fn(async () => {
      throw timeout;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(gateway().complete(INPUT)).rejects.toMatchObject({ transportReason: 'request_timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('body vide → illisible ; JSON invalide → illisible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => '',
        json: async () => ({}),
      })),
    );
    await expect(gateway().complete(INPUT)).rejects.toBeInstanceOf(AiInvalidResponseException);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<html>bad gateway</html>',
        json: async () => ({}),
      })),
    );
    await expect(gateway().complete(INPUT)).rejects.toBeInstanceOf(AiInvalidResponseException);
  });

  it('réponse tronquée (length + JSON coupé) → non-JSON, jamais réparée', async () => {
    stubFetchOnce(200, groqPayload('{"reply":"Il y a 1 technicien disponibl', 'length'));
    await expect(gateway().completeJson(INPUT)).rejects.toMatchObject({ message: 'Réponse IA non-JSON.' });
  });
});

describe('retry 429 Groq — unique, borné, fail-open', () => {
  it('429 → retry → 200 : succès en 2 appels', async () => {
    const fetchMock = stubSequence([
      { status: 429, payload: { error: { message: 'Rate limit reached' } }, retryAfter: '0' },
      { status: 200, payload: groqPayload('{"a":1}') },
    ]);
    const result = await gateway().completeJson<{ a: number }>(INPUT);
    expect(result.result).toEqual({ a: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('429 → 429 : échec propre upstream_rate_limited, aucun 3e appel', async () => {
    const fetchMock = stubSequence([
      { status: 429, payload: {}, retryAfter: '0' },
      { status: 429, payload: {} },
      { status: 200, payload: groqPayload('{"a":1}') },
    ]);
    const error = await gateway().completeJson(INPUT).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AiUpstreamException);
    expect(error).toMatchObject({ httpStatus: 429, transportReason: 'upstream_rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('contrat IA-11 sur Groq — planner + synthèse', () => {
  it('plan JSON strict + synthèse JSON strict traversent le gateway', async () => {
    stubFetchOnce(200, groqPayload('Voici le plan :\n```json\n{"tool":"get_technicians","args":{}}\n```'));
    const plan = await gateway().completeJson<{ tool: string }>({
      caller: 'AiAdminAgentPlan',
      messages: [{ role: 'user', content: 'Techniciens disponibles ?' }],
      maxTokens: 800,
    });
    expect(plan.result).toEqual({ tool: 'get_technicians', args: {} });
    expect(plan.finishReason).toBe('stop');

    stubFetchOnce(200, groqPayload('{"reply":"1 technicien disponible."}'));
    const synth = await gateway().completeJson<{ reply: string }>({
      caller: 'AiAdminAgentSynth',
      messages: [{ role: 'user', content: 'Question : Techniciens ?' }],
      maxTokens: 1500,
    });
    expect(synth.result).toEqual({ reply: '1 technicien disponible.' });
  });
});

describe('secrets Groq — jamais exposés', () => {
  it('gsk- expurgée des logs même interpolée, Authorization masquée', async () => {
    const { warns } = captureLogs();
    stubFetchOnce(401, { error: { message: `Invalid key ${FAKE_KEY}` } });
    const error = await gateway().complete(INPUT).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AiTerminalException);
    expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
    expect(warns.join('\n')).not.toContain(FAKE_KEY);
    expect(warns.join('\n')).not.toContain('gsk-test');
  });
});
