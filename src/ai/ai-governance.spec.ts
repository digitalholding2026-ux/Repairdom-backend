import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { AiConfig } from './ai.config.js';
import { AiGatewayService } from './ai-gateway.service.js';
import { AiClassificationService } from './ai-classification.service.js';

/* IA-10 — gouvernance et sécurité (garde-fous transverses IA-1 → IA-9) :
 * secrets isolés, modèle configurable sans hardcode, PII exclues des
 * payloads, logs sans secret/contenu, confiance bornée, aucune écriture
 * métier automatique, fail-open. */

const AI_DIR = __dirname;

function serviceSources(): Array<{ name: string; content: string }> {
  return readdirSync(AI_DIR)
    .filter((file) => file.endsWith('.service.ts'))
    .map((file) => ({ name: file, content: readFileSync(join(AI_DIR, file), 'utf8') }));
}

function configService(values: Record<string, string | undefined> = {}) {
  return {
    get: (key: string) => values[key],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('secrets — clé strictement backend, jamais dans le corps ni les logs', () => {
  it('corps de requête sans clé, en-tête Authorization seul porteur', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return {
          status: 200,
          json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }], model: 'm' }),
        };
      }),
    );
    const gateway = new AiGatewayService(
      new AiConfig(configService({ AI_ENABLED: 'true', OPENROUTER_API_KEY: 'sk-or-SECRET-XYZ' }) as never),
    );
    await gateway.completeJson({ caller: 'GovernanceTest', messages: [{ role: 'user', content: 'bonjour' }] });
    expect(seen).toHaveLength(1);
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or-SECRET-XYZ');
    const body = String(seen[0].init.body);
    expect(body).not.toContain('sk-or-SECRET-XYZ');
    expect(JSON.parse(body)).toMatchObject({ model: expect.any(String), messages: expect.any(Array) });
  });

  it('logs sans clé ni contenu de prompt', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }], model: 'm' }),
      })),
    );
    const gateway = new AiGatewayService(
      new AiConfig(configService({ AI_ENABLED: 'true', OPENROUTER_API_KEY: 'sk-or-SECRET-XYZ' }) as never),
    );
    await gateway.completeJson({
      caller: 'GovernanceTest',
      messages: [{ role: 'user', content: 'contenu sensible du prompt SENTINEL-42' }],
    });
    const output = logs.join('\n');
    expect(output).not.toContain('sk-or-SECRET-XYZ');
    expect(output).not.toContain('SENTINEL-42');
  });
});

describe('modèle — configurable, jamais hardcodé dans les services', () => {
  it('OPENROUTER_MODEL respecté, défaut sinon', () => {
    const custom = new AiConfig(configService({ OPENROUTER_MODEL: 'thinkingmachines/inkling-small:free' }) as never);
    expect(custom.model).toBe('thinkingmachines/inkling-small:free');
    const fallback = new AiConfig(configService({}) as never);
    expect(fallback.model).toBe('openai/gpt-4o-mini');
  });

  it('aucun identifiant de modèle fournisseur dans les services IA', () => {
    const pattern = /(openai|anthropic|thinkingmachines|meta-llama|mistralai|google|qwen|deepseek)\//;
    for (const { name, content } of serviceSources()) {
      const code = content
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');
      expect(code, name).not.toMatch(pattern);
    }
  });

  it('aucun appel gateway ne surcharge le modèle', () => {
    for (const { name, content } of serviceSources()) {
      // Les appels gateway passent caller/messages/timeoutMs/correlationId
      // (un argument par ligne) : `model:` n'y apparaît jamais (la persistance
      // utilise `model: this.aiConfig.model`, jamais un littéral).
      const lines = content.split('\n');
      const callStarts = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /await this\.gateway\.complete(Json)?</.test(line))
        .map(({ index }) => index);
      // Services sans appel (ex. ai-admin lecture seule) : rien à vérifier.
      for (const start of callStarts) {
        const block = lines.slice(start, start + 12).join('\n');
        expect(block, `${name} : surcharge model interdite`).not.toMatch(/^\s*model\s*:/m);
      }
    }
  });
});

describe('PII — champs supplémentaires jamais transmis au modèle', () => {
  it('classification : clés parasites (téléphone/email/…) ignorées', async () => {
    const inputs: unknown[] = [];
    const gateway = {
      completeJson: vi.fn(async (input: unknown) => {
        inputs.push(input);
        return { result: { domainId: null, confidence: 0.1, suggestedCategories: [], reason: 'x', classification: 'UNCERTAIN' }, model: 'm', durationMs: 1 };
      }),
    };
    const prisma = {
      demandeClassification: { findUnique: vi.fn(async () => null), upsert: vi.fn(async ({ create }: { create: unknown }) => create) },
      serviceDomain: { findMany: vi.fn(async () => []) },
    };
    const service = new AiClassificationService(prisma as never, configService() as never, gateway as never, {
      enabled: true,
      classificationMinConfidence: 0.7,
      classificationTimeoutMs: 8000,
    } as never);
    await service.classifyAutreDemande({
      demandeId: 'd-1',
      description: 'chauffe-eau en panne',
      city: 'Douala',
      phone: '+237690000000',
      email: 'x@y.z',
      address: 'Rue précise 123',
      latitude: 4.05,
      solde: 99999,
    } as never);
    expect(inputs).toHaveLength(1);
    const prompt = (inputs[0] as { messages: Array<{ content: string }> }).messages.map((m) => m.content).join('\n');
    for (const leak of ['+237690000000', 'x@y.z', 'Rue précise 123', '4.05', '99999']) {
      expect(prompt).not.toContain(leak);
    }
    expect(prompt).toContain('chauffe-eau en panne');
  });
});

describe('confiance — bornée [0, 1], seuils centralisés', () => {
  it('seuils IA-4/IA-8 clampés, défaut 0.7', () => {
    const extreme = new AiConfig(
      configService({ AI_CLASSIFICATION_MIN_CONFIDENCE: '5', AI_CHAT_MIN_CONFIDENCE: '-2' }) as never,
    );
    expect(extreme.classificationMinConfidence).toBe(1);
    expect(extreme.chatMinConfidence).toBe(0);
    const invalid = new AiConfig(configService({}) as never);
    expect(invalid.classificationMinConfidence).toBe(0.7);
    expect(invalid.chatMinConfidence).toBe(0.7);
  });
});

describe('anti-sanction — aucun service IA n’écrit les tables métier', () => {
  it('pas de update/delete/upsert sur quote/demande/message/user', () => {
    const pattern = /prisma\.(quote|demande|message|user)\.(update|updateMany|delete|deleteMany|upsert)\b/;
    for (const { name, content } of serviceSources()) {
      expect(content, name).not.toMatch(pattern);
    }
  });
});

describe('fail-open — gateway désactivé : refus propre, aucun appel réseau', () => {
  it('AI_DISABLED → exception typée sans fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new AiGatewayService(new AiConfig(configService({ AI_ENABLED: 'false' }) as never));
    await expect(
      gateway.complete({ caller: 'GovernanceTest', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'AI_DISABLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
