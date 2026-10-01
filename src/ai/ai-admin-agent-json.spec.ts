import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { AiConfig } from './ai.config.js';
import { AiGatewayService, parseJsonDetailed } from './ai-gateway.service.js';
import {
  AI_AGENT_FAILURE_MESSAGE,
  AI_AGENT_MAX_REPLY_CHARS,
  AI_AGENT_MISUNDERSTOOD_MESSAGE,
  AiAdminAgentService,
} from './ai-admin-agent.service.js';

/* IA-11 diagnostic — réponses JSON intermittentes (HTTP 200 invalide).
 * Cible : distinction extraction / json_parse / schema_validation via le
 * vrai gateway (fetch simulée) + agent réel, sans contenu sensible en logs.
 * Aucune réparation sémantique : extraction → parse → validation, échec
 * propre sinon. Modèle, architecture et règles métier inchangés. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CONFIG_VALUES: Record<string, string> = {
  AI_ENABLED: 'true',
  GROQ_API_KEY: 'gsk-test-UNIT',
  GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
};

function realGateway() {
  const config = new AiConfig({ get: (key: string) => CONFIG_VALUES[key] } as never);
  return new AiGatewayService(config);
}

/** fetch simulée : corps provider successifs (plan puis synthèse). */
function stubBodies(bodies: string[], status = 200) {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const content = bodies[Math.min(calls, bodies.length - 1)];
      calls += 1;
      const payload = { choices: [{ message: { content } }], model: 'openai/gpt-oss-120b' };
      return {
        status,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      };
    }),
  );
}

function stubStatus(status: number, payload: unknown) {
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

function stubTimeout() {
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw timeout;
    }),
  );
}

function agentService(gateway: AiGatewayService) {
  const prisma = {
    technicianProfile: {
      count: vi.fn(async () => 20),
      groupBy: vi.fn(async () => [{ kycStatus: 'VERIFIED', _count: { _all: 15 } }]),
    },
    demande: {
      count: vi.fn(async () => 3),
      groupBy: vi.fn(async () => [{ status: 'IN_PROGRESS', _count: { _all: 3 } }]),
      findMany: vi.fn(async () => []),
    },
    demandeClassification: { count: vi.fn(async () => 1) },
    user: {
      count: vi.fn(async () => 5),
      groupBy: vi.fn(async () => [{ role: 'TECHNICIAN', _count: { _all: 5 } }]),
    },
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

const SYNTH_OK = '{"reply":"2 techniciens disponibles."}';

describe('parseJsonDetailed — étape exacte sans contenu', () => {
  it('vide → extraction/empty_response', () => {
    const result = parseJsonDetailed('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.parseStage).toBe('extraction');
      expect(result.failureReason).toBe('empty_response');
    }
  });

  it('texte sans structure → extraction/no_json_structure', () => {
    const result = parseJsonDetailed('désolé, je ne sais pas');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.parseStage).toBe('extraction');
      expect(result.failureReason).toBe('no_json_structure');
    }
  });

  it('JSON tronqué → extraction/truncated_structure', () => {
    const result = parseJsonDetailed('Voici : {"tool":"get_overview"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.parseStage).toBe('extraction');
      expect(result.failureReason).toBe('truncated_structure');
    }
  });

  it('syntaxe invalide → json_parse/unexpected_token', () => {
    const result = parseJsonDetailed('{"a":1,}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.parseStage).toBe('json_parse');
      expect(result.failureReason).toBe('unexpected_token');
    }
  });

  it('deux objets → json_parse/ambiguous_multiple_json (jamais arbitré)', () => {
    const result = parseJsonDetailed('{"a":1} {"b":2}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.parseStage).toBe('json_parse');
      expect(result.failureReason).toBe('ambiguous_multiple_json');
    }
  });

  it('surdimensionné non pur → extraction/oversize', () => {
    const result = parseJsonDetailed(`préambule ${'x'.repeat(40_000)} {"a":1}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.parseStage).toBe('extraction');
      expect(result.failureReason).toBe('oversize');
    }
  });

  it.each([
    ['pur', '{"tool":"get_technicians","period":"today"}'],
    ['markdown', '```json\n{"tool":"get_technicians","period":"today"}\n```'],
    ['texte avant', 'Here is the result:\n{"tool":"get_technicians","period":"today"}'],
    ['texte après', '{"tool":"get_technicians","period":"today"}\nHope this helps.'],
    ['avant + bloc + après', 'Résultat :\n```json\n{"tool":"get_technicians"}\n```\nFin.'],
    ['accolades en chaîne', '{"reason":"Le texte contient {des accolades}."}'],
    ['échappements', '{"answer":"tableau [1,2] et \\"guillemets\\""}'],
    ['tableau', '[1, 2, 3]'],
  ])('ok : %s', (_label, text) => {
    const result = parseJsonDetailed(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnosis.jsonExtractionSucceeded).toBe(true);
      expect(result.diagnosis.jsonParseSucceeded).toBe(true);
      expect(result.diagnosis.responseLength).toBe(text.length);
    }
  });

  it('diagnostic sans contenu : bornes + fence, jamais le texte', () => {
    const secret = '```json\n{"tool":"get_overview","args":{}}\n```';
    const result = parseJsonDetailed(secret);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnosis.firstNonWhitespaceChar).toBe('`');
      expect(result.diagnosis.lastNonWhitespaceChar).toBe('`');
      expect(result.diagnosis.hasMarkdownFence).toBe(true);
      expect(JSON.stringify(result.diagnosis)).not.toContain('get_overview');
    }
  });
});

describe('gateway — extraction contenu provider', () => {
  it('contenu en parties [{text}] → concaténé (pas inexploitable)', async () => {
    const payload = {
      choices: [{ message: { content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] } }],
      model: 'm',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      })),
    );
    const result = await realGateway().completeJson<{ a: number }>({
      caller: 'DiagTest',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.result).toEqual({ a: 1 });
  });

  it('200 sans choix → inexploitable (extraction)', async () => {
    stubStatus(200, { choices: [] });
    await expect(realGateway().complete({ caller: 'DiagTest', messages: [{ role: 'user', content: 'x' }] })).rejects
      .toMatchObject({ message: 'Réponse IA inexploitable.' });
  });

  it('corps HTTP illisible → illisible (transport)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => {
          throw new SyntaxError('Unexpected end of input');
        },
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      })),
    );
    await expect(realGateway().complete({ caller: 'DiagTest', messages: [{ role: 'user', content: 'x' }] })).rejects
      .toMatchObject({ message: 'Réponse IA illisible.' });
  });

  it('429 → upstream rejouable, 500 → upstream, timeout → upstream', async () => {
    stubStatus(429, { error: 'rate limited' });
    await expect(
      realGateway().complete({ caller: 'DiagTest', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ name: 'AiUpstreamException' });
    stubStatus(500, { error: 'boom' });
    await expect(
      realGateway().complete({ caller: 'DiagTest', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ name: 'AiUpstreamException' });
    stubTimeout();
    await expect(
      realGateway().complete({ caller: 'DiagTest', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ name: 'AiUpstreamException' });
  });

  it('échec completeJson → log métadonnées sans contenu', async () => {
    const { warns } = captureLogs();
    stubBodies(['pas du json du tout']);
    await expect(
      realGateway().completeJson({ caller: 'DiagStage', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ message: 'Réponse IA non-JSON.' });
    const line = warns.join('\n');
    expect(line).toContain('parseStage=extraction');
    expect(line).toContain('failureReason=no_json_structure');
    expect(line).toContain('responseLength=');
    expect(line).not.toContain('pas du json du tout');
  });
});

describe('planner — matrice des formats (bout en bout)', () => {
  it.each([
    ['pur', '{"tool":"get_technicians","args":{}}'],
    ['markdown', '```json\n{"tool":"get_technicians","args":{}}\n```'],
    ['texte + JSON', 'Here is the result:\n{"tool":"get_technicians","args":{}}'],
    ['JSON + texte', '{"tool":"get_technicians","args":{}}\nHope this helps.'],
    ['avant + bloc + après', 'Résultat :\n```json\n{"tool":"get_technicians","args":{}}\n```\nFin.'],
  ])('%s → tool exécuté, synthèse avec vrais chiffres', async (_label, plan) => {
    stubBodies([plan, SYNTH_OK]);
    const result = await agentService(realGateway()).chat('Techniciens disponibles ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_technicians', ok: true }]);
    expect(result.reply).toContain('2 techniciens');
  });

  it('réponse vide → échec propre, aucun tool', async () => {
    stubBodies(['   ', SYNTH_OK]);
    const result = await agentService(realGateway()).chat('Techniciens disponibles ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    expect(result.toolCalls).toEqual([]);
  });

  it('JSON syntaxiquement invalide → échec propre, rien d’inventé', async () => {
    stubBodies(['{"tool":"get_technicians",', SYNTH_OK]);
    const result = await agentService(realGateway()).chat('Techniciens disponibles ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    expect(result.reply).not.toMatch(/\d+ technicien/);
  });

  it('JSON valide mais schéma invalide → incompréhension ou échec, jamais validé', async () => {
    // {"foo":"bar"} : pas de clé tool → plan "none" ; la synthèse sans
    // données échoue proprement (corps sans reply) : aucun tool validé.
    stubBodies(['```json\n{"foo":"bar"}\n```', '{"foo":"bar"}']);
    const result = await agentService(realGateway()).chat('blabla');
    expect([AI_AGENT_FAILURE_MESSAGE, AI_AGENT_MISUNDERSTOOD_MESSAGE]).toContain(result.reply);
    expect(result.toolCalls).toEqual([]);
    // Variante : tool non-chaîne → incompréhension directe, sans synthèse.
    stubBodies(['{"tool":123,"args":{}}', SYNTH_OK]);
    const direct = await agentService(realGateway()).chat('blabla ???');
    expect(direct.reply).toBe(AI_AGENT_MISUNDERSTOOD_MESSAGE);
    expect(direct.toolCalls).toEqual([]);
  });

  it('mauvais tool → incompréhension, aucun tool exécuté', async () => {
    stubBodies(['{"tool":"drop_database","args":{}}', SYNTH_OK]);
    const result = await agentService(realGateway()).chat('blabla ???');
    expect(result.reply).toBe(AI_AGENT_MISUNDERSTOOD_MESSAGE);
    expect(result.toolCalls).toEqual([]);
  });

  it('période invalide → today (valeur sûre), tool exécuté', async () => {
    stubBodies(['{"tool":"get_demandes","args":{"period":"forever"}}', SYNTH_OK]);
    const result = await agentService(realGateway()).chat('Demandes ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_demandes', ok: true }]);
  });

  it.each([
    ['429', 429],
    ['500', 500],
  ])('HTTP %s côté plan → échec propre', async (_label, status) => {
    stubStatus(status, { error: 'boom' });
    const result = await agentService(realGateway()).chat('Techniciens disponibles ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    expect(result.toolCalls).toEqual([]);
  });

  it('timeout côté plan → échec propre', async () => {
    stubTimeout();
    const result = await agentService(realGateway()).chat('Techniciens disponibles ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
  });
});

describe('synthesizer — matrice des formats', () => {
  const PLAN = '{"tool":"get_technicians","args":{}}';

  it.each([
    ['pur', '{"reply":"1 technicien disponible."}'],
    ['markdown', '```json\n{"reply":"1 technicien disponible."}\n```'],
    ['prose + JSON', 'Voici la synthèse : {"reply":"1 technicien disponible."}'],
    ['accolades en chaîne', '{"reply":"Le motif contient {des accolades}."}'],
  ])('%s → reply extraite', async (_label, synth) => {
    stubBodies([PLAN, synth]);
    const result = await agentService(realGateway()).chat('Techniciens ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_technicians', ok: true }]);
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('accolades en chaîne → extraction non tronquée (équilibrée)', async () => {
    stubBodies([PLAN, '{"reply":"Le motif contient {des accolades}."}']);
    const result = await agentService(realGateway()).chat('Techniciens ?');
    expect(result.reply).toBe('Le motif contient {des accolades}.');
  });

  it('synthèse non-JSON → échec propre (HTTP 200 + non-JSON)', async () => {
    stubBodies([PLAN, 'Je ne peux pas répondre en JSON, désolé']);
    const result = await agentService(realGateway()).chat('Techniciens ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
  });

  it('synthèse JSON sans reply → échec propre (parse OK, schéma KO)', async () => {
    stubBodies([PLAN, '{"foo":"bar"}']);
    const result = await agentService(realGateway()).chat('Techniciens ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
  });

  it('synthèse reply vide → échec propre', async () => {
    stubBodies([PLAN, '{"reply":"   "}']);
    const result = await agentService(realGateway()).chat('Techniciens ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
  });

  it('timeout côté synthèse → échec propre, tool déjà exécuté', async () => {
    let calls = 0;
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          const payload = {
            choices: [{ message: { content: PLAN } }],
            model: 'openai/gpt-oss-120b',
          };
          return {
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify(payload),
            json: async () => payload,
          };
        }
        throw timeout;
      }),
    );
    const result = await agentService(realGateway()).chat('Techniciens ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    // Contrat actuel : toute exception → message propre + toolCalls [].
    expect(result.toolCalls).toEqual([]);
  });
});

describe('IA-11 complet — chiffres backend uniquement', () => {
  it.each([
    ['techniciens disponibles', '{"tool":"get_technicians","args":{}}'],
    ['activité aujourd’hui', '{"tool":"get_demandes","args":{"period":"today"}}'],
    ['nouvelles inscriptions', '{"tool":"get_users","args":{"period":"today"}}'],
    ['missions en cours', '{"tool":"get_missions","args":{"period":"today"}}'],
    ['techniciens en route', '{"tool":"get_technicians","args":{}}'],
    ['surveillance IA', '{"tool":"get_overview","args":{}}'],
    ['demandes récentes', '{"tool":"get_recent_demandes","args":{"limit":5}}'],
  ])('%s → tool exécuté, réponse factuelle', async (_label, plan) => {
    stubBodies([plan, SYNTH_OK]);
    const result = await agentService(realGateway()).chat('Question admin ?');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].ok).toBe(true);
    expect(result.reply).toBe('2 techniciens disponibles.');
  });

  it('question inconnue (tool null) → réponse sans chiffre inventé', async () => {
    stubBodies(['{"tool":null,"args":{}}', '{"reply":"Je peux décrire mes capacités : posez une question chiffrée."}']);
    const result = await agentService(realGateway()).chat('Bonjour, que sais-tu faire ?');
    expect(result.toolCalls).toEqual([]);
    expect(result.reply).toContain('capacités');
  });

  it('question multi-sujets → un seul tool, synthèse bornée aux données', async () => {
    stubBodies(['{"tool":"get_overview","args":{}}', SYNTH_OK]);
    const result = await agentService(realGateway()).chat('Surveillance IA et techniciens disponibles ?');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.reply).toBe('2 techniciens disponibles.');
  });
});

describe('logs Plan/Synth — distinguables, sans contenu sensible', () => {
  it('succès → "plan ok" + "synth ok" avec durées, sans question ni chiffres', async () => {
    const { logs } = captureLogs();
    stubBodies(['{"tool":"get_technicians","args":{}}', SYNTH_OK]);
    const question = 'QuestionSecreteZ9Q techniciens disponibles ?';
    await agentService(realGateway()).chat(question);
    const planOk = logs.find((line) => line.includes('plan ok'));
    const synthOk = logs.find((line) => line.includes('synth ok'));
    expect(planOk).toContain('tool=get_technicians');
    expect(planOk).toContain('durationMs=');
    expect(synthOk).toContain('replyLength=');
    expect(logs.join('\n')).not.toContain('QuestionSecreteZ9Q');
  });

  it('plan non-JSON → plan failed json_parse + échec propre', async () => {
    const { warns } = captureLogs();
    stubBodies(['réponse en prose sans JSON', SYNTH_OK]);
    const result = await agentService(realGateway()).chat('Techniciens ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    const line = warns.find((entry) => entry.includes('plan failed'));
    expect(line).toContain('parseStage=json_parse');
    expect(line).toContain('failureReason=non_json_content');
    expect(line).toContain('httpStatus=200');
  });

  it('plan 200 vide → plan failed extraction (inexploitable)', async () => {
    const { warns } = captureLogs();
    stubStatus(200, { choices: [] });
    const result = await agentService(realGateway()).chat('Techniciens ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    expect(warns.join('\n')).toContain('parseStage=extraction');
  });

  it('plan schéma invalide → schema_validation/unknown_tool sans valeur brute', async () => {
    const { warns } = captureLogs();
    stubBodies(['{"tool":"outil_pirate_xyz","args":{}}', SYNTH_OK]);
    const result = await agentService(realGateway()).chat('blabla');
    expect(result.reply).toBe(AI_AGENT_MISUNDERSTOOD_MESSAGE);
    const line = warns.find((entry) => entry.includes('plan failed')) ?? '';
    expect(line).toContain('parseStage=schema_validation');
    expect(line).toContain('failureReason=unknown_tool');
    expect(line).not.toContain('outil_pirate_xyz');
  });

  it('synthèse schéma invalide → synth failed schema_validation/missing_reply', async () => {
    const { warns } = captureLogs();
    stubBodies(['{"tool":"get_technicians","args":{}}', '{"noreply":1}']);
    const result = await agentService(realGateway()).chat('Techniciens ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    const line = warns.find((entry) => entry.includes('synth failed')) ?? '';
    expect(line).toContain('parseStage=schema_validation');
    expect(line).toContain('failureReason=missing_reply');
  });
});

/* IA-11.2 — anti-troncature : plafonds `max_tokens` (plan 800 / synthèse
 * 1500), prompts compacts, `finish_reason=length` explicite. Le JSON
 * tronqué n'est JAMAIS réparé : échec propre, rien d'inventé. */

function choicePayload(content: string | null, finishReason: string | null) {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    model: 'openai/gpt-oss-120b',
  };
}

/** fetch simulée à pas explicites + capture des corps envoyés. */
function stubSteps(
  steps: Array<{ status: number; payload: unknown; retryAfter?: string }>,
  sentBodies: string[] = [],
) {
  let calls = 0;
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    if (typeof init?.body === 'string') sentBodies.push(init.body);
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
  return { fetchMock, callCount: () => fetchMock.mock.calls.length };
}

function configWith(values: Record<string, string | undefined>) {
  return new AiConfig({ get: (key: string) => values[key] } as never);
}

describe('IA-11.2 — configuration centralisée des plafonds', () => {
  it('défauts : plan 800, synthèse 1500', () => {
    const config = configWith({});
    expect(config.agentPlanMaxTokens).toBe(800);
    expect(config.agentSynthMaxTokens).toBe(1500);
  });

  it('surcharges env bornées', () => {
    expect(configWith({ AI_AGENT_PLAN_MAX_TOKENS: '1200' }).agentPlanMaxTokens).toBe(1200);
    expect(configWith({ AI_AGENT_SYNTH_MAX_TOKENS: '2000' }).agentSynthMaxTokens).toBe(2000);
    expect(configWith({ AI_AGENT_PLAN_MAX_TOKENS: 'nawak' }).agentPlanMaxTokens).toBe(800);
    expect(configWith({ AI_AGENT_PLAN_MAX_TOKENS: '10' }).agentPlanMaxTokens).toBe(200);
    expect(configWith({ AI_AGENT_PLAN_MAX_TOKENS: '99999' }).agentPlanMaxTokens).toBe(4000);
    expect(configWith({ AI_AGENT_SYNTH_MAX_TOKENS: '10' }).agentSynthMaxTokens).toBe(400);
    expect(configWith({ AI_AGENT_SYNTH_MAX_TOKENS: '99999' }).agentSynthMaxTokens).toBe(8000);
  });
});

describe('IA-11.2 — câblage max_tokens + prompts compacts', () => {
  it('plan → max_tokens 800, synthèse → max_tokens 1500, sans autre paramètre', async () => {
    const sent: string[] = [];
    stubSteps(
      [
        { status: 200, payload: choicePayload('{"tool":"get_technicians","args":{}}', 'stop') },
        { status: 200, payload: choicePayload(SYNTH_OK, 'stop') },
      ],
      sent,
    );
    const result = await agentService(realGateway()).chat('Techniciens disponibles ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_technicians', ok: true }]);
    expect(sent).toHaveLength(2);
    const planBody = JSON.parse(sent[0]) as Record<string, unknown>;
    const synthBody = JSON.parse(sent[1]) as Record<string, unknown>;
    expect(planBody.max_tokens).toBe(800);
    expect(synthBody.max_tokens).toBe(1500);
    for (const body of [planBody, synthBody]) {
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body).not.toHaveProperty('reasoning');
    }
    const planSystem = (planBody.messages as Array<{ content: string }>)[0].content;
    const synthSystem = (synthBody.messages as Array<{ content: string }>)[0].content;
    expect(planSystem).toMatch(/moins de 200 caractères/);
    expect(planSystem).toContain('get_recent_demandes');
    expect(synthSystem).toMatch(/une à deux phrases/);
    expect(synthSystem).toContain('{"reply"');
  });
});

describe('IA-11.2 — troncature finish_reason=length (cas production)', () => {
  it('planner vide + length → échec propre, rien d’inventé, cause loggée', async () => {
    const { warns } = captureLogs();
    stubSteps([{ status: 200, payload: choicePayload('', 'length') }]);
    const result = await agentService(realGateway()).chat('Techniciens disponibles ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    expect(result.reply).not.toMatch(/\d+ technicien/);
    expect(result.toolCalls).toEqual([]);
    const joined = warns.join('\n');
    expect(joined).toContain('finishReason=length');
    expect(joined).toContain('failureReason=invalid_provider_payload');
  });

  it('synthèse tronquée `{"reply":"…\\` + length → refusée, jamais réparée', async () => {
    const { warns } = captureLogs();
    const truncated = '{"reply":"Il y a 1 technicien disponible et 2 missions en cou\\';
    stubSteps([
      { status: 200, payload: choicePayload('{"tool":"get_technicians","args":{}}', 'stop') },
      { status: 200, payload: choicePayload(truncated, 'length') },
    ]);
    const result = await agentService(realGateway()).chat('Techniciens disponibles ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    expect(result.reply).not.toContain('1 technicien');
    const joined = warns.join('\n');
    expect(joined).toContain('parseStage=extraction');
    expect(joined).toContain('failureReason=truncated_structure');
    expect(joined).toContain('finishReason=length');
  });

  it('réponse complète juste sous la limite (stop) → succès, finishReason propagé', async () => {
    stubSteps([
      { status: 200, payload: choicePayload('{"tool":"get_overview","args":{}}', 'stop') },
      { status: 200, payload: choicePayload('{"reply":"2 avertissements ouverts."}', 'stop') },
    ]);
    const gateway = realGateway();
    const result = await agentService(gateway).chat('Surveillance IA ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_overview', ok: true }]);
    expect(result.reply).toBe('2 avertissements ouverts.');
    const direct = await gateway.completeJson<{ reply: string }>({
      caller: 'LengthCheck',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(direct.finishReason).toBe('stop');
  });
});

describe('IA-11.2 — synthèse courte, contrats inchangés', () => {
  it.each([
    ['compteurs multiples', '{"tool":"get_overview","args":{}}', '{"reply":"2 avertissements ouverts, 1 signal à revoir."}'],
    ['liste de demandes', '{"tool":"get_recent_demandes","args":{"limit":5}}', '{"reply":"3 demandes récentes, dont 1 en cours."}'],
    ['surveillance IA', '{"tool":"get_overview","args":{}}', '{"reply":"Surveillance nominale : 2 signaux à revoir."}'],
    ['sans données', '{"tool":null,"args":{}}', '{"reply":"Je ne dispose pas de donnée structurée."}'],
  ])('%s → reply exacte, courte', async (_label, plan, synth) => {
    stubBodies([plan, synth]);
    const result = await agentService(realGateway()).chat('Question ?');
    expect(result.reply.length).toBeLessThanOrEqual(200);
  });

  it('reply longue → bornée à AI_AGENT_MAX_REPLY_CHARS, jamais d’invention', async () => {
    const longReply = `{"reply":"${'x'.repeat(5000)}"}`;
    stubBodies(['{"tool":"get_technicians","args":{}}', longReply]);
    const result = await agentService(realGateway()).chat('Techniciens ?');
    expect(result.reply).toHaveLength(AI_AGENT_MAX_REPLY_CHARS);
  });
});

/* IA-11.3 — problème B : synthèse prose brute + finish_reason=stop
 * (réponse complète mais hors contrat). AUCUNE conversion auto en
 * {"reply":…} : échec contrôlé, cause loggée. */

describe('IA-11.3 — synthèse non-JSON malgré finish_reason=stop', () => {
  it('prose 60 car. + stop → non_json_content, jamais convertie', async () => {
    const { warns } = captureLogs();
    const prose = 'Analyse des techniciens disponibles sur la plateforme.';
    expect(prose).toHaveLength(54);
    stubSteps([
      { status: 200, payload: choicePayload('{"tool":"get_technicians","args":{}}', 'stop') },
      { status: 200, payload: choicePayload(prose, 'stop') },
    ]);
    const result = await agentService(realGateway()).chat('Techniciens disponibles ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    expect(result.reply).not.toContain('technicien disponible');
    const joined = warns.join('\n');
    expect(joined).toContain('failureReason=no_json_structure');
    expect(joined).toContain('failureReason=non_json_content');
    expect(joined).toContain('finishReason=stop');
  });

  it('prompt synthèse : JSON seul exigé en tête, règles conservées', async () => {
    const sent: string[] = [];
    stubSteps(
      [
        { status: 200, payload: choicePayload('{"tool":null,"args":{}}', 'stop') },
        { status: 200, payload: choicePayload('{"reply":"ok."}', 'stop') },
      ],
      sent,
    );
    await agentService(realGateway()).chat('Que sais-tu faire ?');
    const synthBody = JSON.parse(sent[1]) as { messages: Array<{ content: string }> };
    const system = synthBody.messages[0].content;
    expect(system.startsWith('Tu réponds UNIQUEMENT en JSON')).toBe(true);
    expect(system).toMatch(/aucun markdown.*prose hors JSON/i);
    expect(system).toContain('{"reply"');
    expect(system).toContain('une à deux phrases');
    expect(system).toContain('jamais d’invention');
    expect(system).toContain('Africa/Douala');
  });
});

describe('IA-11.3 — questions production bout en bout', () => {
  it.each([
    ['Techniciens disponibles ?', '{"tool":"get_technicians","args":{}}', 'get_technicians'],
    ['Client disponible sur la plateforme ?', '{"tool":"get_users","args":{"period":"today"}}', 'get_users'],
    ['Activité aujourd’hui ?', '{"tool":"get_demandes","args":{"period":"today"}}', 'get_demandes'],
    ['Nouvelles inscriptions ?', '{"tool":"get_users","args":{"period":"today"}}', 'get_users'],
    ['Missions en cours ?', '{"tool":"get_missions","args":{"period":"today"}}', 'get_missions'],
    ['Techniciens en route ?', '{"tool":"get_technicians","args":{}}', 'get_technicians'],
    ['Surveillance IA ?', '{"tool":"get_overview","args":{}}', 'get_overview'],
    ['Demandes récentes ?', '{"tool":"get_recent_demandes","args":{"limit":5}}', 'get_recent_demandes'],
  ])('%s → plan valide + outil + synthèse', async (_question, plan, tool) => {
    stubSteps([
      { status: 200, payload: choicePayload(plan, 'stop') },
      { status: 200, payload: choicePayload('{"reply":"Réponse factuelle courte."}', 'stop') },
    ]);
    const result = await agentService(realGateway()).chat('Question admin ?');
    expect(result.toolCalls).toEqual([{ tool, ok: true }]);
    expect(result.reply).toBe('Réponse factuelle courte.');
  });
});

/* IA-11.4 — retry 429 par appel : le retry du Planner ne rejoue ni
 * l'exécuteur ni la synthèse, celui du Synth ne rappelle pas le Planner.
 * L'exécuteur backend tourne exactement une fois par question. */

function agentServiceWithPrisma(gateway: AiGatewayService) {
  const prisma = {
    technicianProfile: {
      count: vi.fn(async () => 20),
      groupBy: vi.fn(async () => [{ kycStatus: 'VERIFIED', _count: { _all: 15 } }]),
    },
    demande: {
      count: vi.fn(async () => 3),
      groupBy: vi.fn(async () => [{ status: 'IN_PROGRESS', _count: { _all: 3 } }]),
      findMany: vi.fn(async () => []),
    },
    demandeClassification: { count: vi.fn(async () => 0) },
    user: {
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => []),
    },
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
  const overview = { getOverview: vi.fn(async () => ({})) };
  const service = new AiAdminAgentService(prisma as never, aiConfig as never, gateway as never, overview as never);
  return { service, prisma };
}

describe('IA-11.4 — Cas 3 : retry Planner sans relance du workflow', () => {
  it('plan 429 → retry → OK : exécuteur ×1, synthèse ×1, plan envoyé ×2', async () => {
    const { warns } = captureLogs();
    const sent: string[] = [];
    const { callCount } = stubSteps(
      [
        { status: 429, payload: { error: 'rate limited' }, retryAfter: '0' },
        { status: 200, payload: choicePayload('{"tool":"get_technicians","args":{}}', 'stop') },
        { status: 200, payload: choicePayload('{"reply":"20 techniciens au total."}', 'stop') },
      ],
      sent,
    );
    const { service, prisma } = agentServiceWithPrisma(realGateway());
    const result = await service.chat('Techniciens disponibles ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_technicians', ok: true }]);
    expect(result.reply).toBe('20 techniciens au total.');
    expect(callCount()).toBe(3);
    const planSends = sent.filter((body) => !JSON.parse(body).messages[0].content.includes('{"reply"'));
    const synthSends = sent.filter((body) => JSON.parse(body).messages[0].content.includes('{"reply"'));
    expect(planSends).toHaveLength(2);
    expect(planSends[0]).toBe(planSends[1]);
    expect(synthSends).toHaveLength(1);
    expect(prisma.technicianProfile.count).toHaveBeenCalledTimes(2);
    expect(prisma.demande.findMany).toHaveBeenCalledTimes(1);
    expect(warns.join('\n')).toContain('AI 429 retry');
  });
});

describe('IA-11.4 — Cas 7 : retry Synth uniquement, Planner non rappelé', () => {
  it('synth 429 → retry → OK : plan ×1, exécuteur ×1', async () => {
    const sent: string[] = [];
    const { callCount } = stubSteps(
      [
        { status: 200, payload: choicePayload('{"tool":"get_technicians","args":{}}', 'stop') },
        { status: 429, payload: { error: 'rate limited' }, retryAfter: '0' },
        { status: 200, payload: choicePayload('{"reply":"20 techniciens au total."}', 'stop') },
      ],
      sent,
    );
    const { service, prisma } = agentServiceWithPrisma(realGateway());
    const result = await service.chat('Techniciens disponibles ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_technicians', ok: true }]);
    expect(result.reply).toBe('20 techniciens au total.');
    expect(callCount()).toBe(3);
    const planSends = sent.filter((body) => !JSON.parse(body).messages[0].content.includes('{"reply"'));
    expect(planSends).toHaveLength(1);
    expect(prisma.technicianProfile.count).toHaveBeenCalledTimes(2);
    expect(prisma.demande.findMany).toHaveBeenCalledTimes(1);
  });

  it('synth 429 → 429 : échec propre, plan ×1, exécuteur ×1', async () => {
    const sent: string[] = [];
    const { callCount } = stubSteps(
      [
        { status: 200, payload: choicePayload('{"tool":"get_technicians","args":{}}', 'stop') },
        { status: 429, payload: { error: 'rate limited' }, retryAfter: '0' },
        { status: 429, payload: { error: 'rate limited' } },
      ],
      sent,
    );
    const { service, prisma } = agentServiceWithPrisma(realGateway());
    const result = await service.chat('Techniciens disponibles ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
    expect(result.toolCalls).toEqual([]);
    expect(callCount()).toBe(3);
    expect(sent.filter((body) => !JSON.parse(body).messages[0].content.includes('{"reply"'))).toHaveLength(1);
    expect(prisma.technicianProfile.count).toHaveBeenCalledTimes(2);
  });
});
