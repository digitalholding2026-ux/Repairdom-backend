import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiGatewayService, parseJsonBody } from './ai-gateway.service.js';
import { AiConfig } from './ai.config.js';
import { AiAdminAgentService } from './ai-admin-agent.service.js';
import {
  AI_AGENT_FAILURE_MESSAGE,
  AI_AGENT_MISUNDERSTOOD_MESSAGE,
} from './ai-admin-agent.service.js';

/* IA-11.1 — robustesse du parsing JSON (couche commune unique) : le modèle
 * encapsule parfois le JSON (fence ```json, prose avant/après). La syntaxe
 * n'est JAMAIS réparée (pas de JSON5, pas de clés corrigées, pas de contenu
 * inventé) ; le contrat reste validé en aval ; fail-open inchangé. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseJsonBody — JSON valide', () => {
  it.each([
    ['pur', '{"tool":"get_overview","args":{}}'],
    ['whitespace', '  \n\t {"tool":"get_overview","args":{}}  \n'],
    ['multiline', '{\n  "tool": "get_overview",\n  "args": {}\n}'],
  ])('%s → accepté', (_label, text) => {
    expect(parseJsonBody(text)).toEqual({ tool: 'get_overview', args: {} });
  });
});

describe('parseJsonBody — encapsulation', () => {
  it.each([
    ['fenced json', '```json\n{"tool":"get_overview","args":{}}\n```'],
    ['fenced nu', '```\n{"tool":"get_overview","args":{}}\n```'],
    ['fence + texte avant', 'Voici le résultat :\n```json\n{"a":1}\n```'],
    ['fence + texte après', '```json\n{"a":1}\n```\nVoilà.'],
    ['texte avant', 'Voici le résultat :\n{"tool":"get_overview","args":{}}'],
    ['texte après', '{"tool":"get_overview","args":{}}\nMerci.'],
    ['texte avant + après', 'Résultat : {"a":1} (fin)'],
    ['fence non fermée', '```json\n{"a":1}'],
  ])('%s → extrait', (_label, text) => {
    expect(parseJsonBody(text)).not.toBeUndefined();
  });

  it('valeurs exactes après extraction', () => {
    expect(parseJsonBody('Voici :\n{"tool":"get_overview","args":{}}')).toEqual({
      tool: 'get_overview',
      args: {},
    });
    expect(parseJsonBody('```json\n{"reply":"ok"}\n```')).toEqual({ reply: 'ok' });
  });
});

describe('parseJsonBody — JSON invalide (jamais réparé)', () => {
  it.each([
    ['accolades incomplètes', '{"tool":"get_overview"'],
    ['JSON tronqué', '{"tool":'],
    ['texte sans JSON', 'désolé, je ne sais pas'],
    ['vide', '   '],
    ['plusieurs objets ambigus', '{"a":1} {"b":2}'],
    ['tableaux ambigus', '[1,2] [3,4]'],
  ])('%s → undefined', (_label, text) => {
    expect(parseJsonBody(text)).toBeUndefined();
  });

  it('aucune correction de syntaxe (trailing comma, clés non quotées)', () => {
    expect(parseJsonBody('{"a":1,}')).toBeUndefined();
    expect(parseJsonBody('{a:1}')).toBeUndefined();
    expect(parseJsonBody("{'a':1}")).toBeUndefined();
  });
});

describe('parseJsonBody — cas sensibles (chaînes avec délimiteurs)', () => {
  it('accolades dans une chaîne JSON', () => {
    expect(parseJsonBody('{"answer":"La chaîne contient {des accolades}."}')).toEqual({
      answer: 'La chaîne contient {des accolades}.',
    });
  });

  it('crochets et guillemets échappés dans une chaîne', () => {
    expect(parseJsonBody('{"answer":"tableau [1,2] et \\"guillemets\\""}')).toEqual({
      answer: 'tableau [1,2] et "guillemets"',
    });
  });

  it('contenu malveillant en chaîne : parsé comme donnée (jamais exécuté)', () => {
    const parsed = parseJsonBody('{"reply":"x\'); DROP TABLE users; --"}') as Record<string, unknown>;
    expect(parsed.reply).toBe("x'); DROP TABLE users; --");
  });

  it('JSON valide mais schema invalide : parsé ici, rejeté par le contrat en aval', () => {
    // parseJsonBody ne valide pas le schema : {"foo":"bar"} parse,
    // mais le planificateur IA-11 le refuse (voir tests IA-11 ci-dessous).
    expect(parseJsonBody('```json\n{"foo":"bar"}\n```')).toEqual({ foo: 'bar' });
  });
});

/* IA-11 bout-en-bout via vrai gateway (fetch simulée) : fence et prose
 * traversent planificateur + synthèse ; non-JSON et schema invalide
 * restent des erreurs contrôlées. */

function gatewayWithFetch(bodies: string[]) {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const content = bodies[Math.min(calls, bodies.length - 1)];
      calls += 1;
      const payload = { choices: [{ message: { content } }], model: 'openai/gpt-oss-120b' };
      return {
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      };
    }),
  );
  const config = new AiConfig(
    {
      get: (key: string) =>
        (
          {
            AI_ENABLED: 'true',
            GROQ_API_KEY: 'gsk-test-UNIT',
            GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
          } as Record<string, string>
        )[key],
    } as never,
  );
  return new AiGatewayService(config);
}

function agentService(gateway: AiGatewayService) {
  const prisma = {
    technicianProfile: { count: vi.fn(async () => 0), groupBy: vi.fn(async () => []) },
    demande: { count: vi.fn(async () => 0), groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) },
    demandeClassification: { count: vi.fn(async () => 0) },
    user: { count: vi.fn(async () => 0), groupBy: vi.fn(async () => []) },
    review: { findMany: vi.fn(async () => []) },
  };
  const aiConfig = {
    isConfigured: () => true,
    refusalReason: () => null,
    model: 'm',
    chatTimeoutMs: 8000,
    agentPlanMaxTokens: 800,
    agentSynthMaxTokens: 1500,
  };
  const overview = { getOverview: vi.fn(async () => ({ warnings: { pending: 2 } })) };
  return new AiAdminAgentService(prisma as never, aiConfig as never, gateway as never, overview as never);
}

describe('completeJson — fence traversant le gateway', () => {
  it('corps fenced → parsé (plus de "Réponse IA non-JSON" abusive)', async () => {
    const gateway = gatewayWithFetch(['```json\n{"a":1}\n```']);
    const result = await gateway.completeJson<{ a: number }>({
      caller: 'JsonParseTest',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.result).toEqual({ a: 1 });
  });
});

describe('IA-11 — Planner fenced de bout en bout', () => {
  it('plan fenced + synthèse fenced → tool exécuté, réponse extraite', async () => {
    const gateway = gatewayWithFetch([
      'Voici le plan :\n```json\n{"tool":"get_overview","args":{}}\n```',
      '```json\n{"reply":"2 avertissements ouverts."}\n```',
    ]);
    const result = await agentService(gateway).chat('Combien d’avertissements sont ouverts ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_overview', ok: true }]);
    expect(result.reply).toBe('2 avertissements ouverts.');
  });

  it('plan en prose + JSON nu → accepté', async () => {
    const gateway = gatewayWithFetch([
      'Plan : {"tool":"get_overview","args":{}} — voilà.',
      '{"reply":"ok."}',
    ]);
    const result = await agentService(gateway).chat('Surveillance ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_overview', ok: true }]);
    expect(result.reply).toBe('ok.');
  });

  it('plan non-JSON → erreur contrôlée (fail-open, rien d’inventé)', async () => {
    const gateway = gatewayWithFetch(['désolé, je ne peux pas répondre en JSON']);
    const result = await agentService(gateway).chat('Surveillance ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    expect(result.toolCalls).toEqual([]);
  });

  it('plan fenced mais schema invalide → jamais validé (aucun tool, fail-open)', async () => {
    const gateway = gatewayWithFetch(['```json\n{"foo":"bar"}\n```']);
    const result = await agentService(gateway).chat('blabla');
    // Pas de tool exécuté ; la synthèse sur données absentes échoue proprement.
    expect(result.toolCalls).toEqual([]);
    expect([AI_AGENT_FAILURE_MESSAGE, AI_AGENT_MISUNDERSTOOD_MESSAGE]).toContain(result.reply);
  });
});
