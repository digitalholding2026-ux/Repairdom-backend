import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AI_AGENT_ACTION_REFUSAL,
  AI_AGENT_DISABLED_MESSAGE,
  AI_AGENT_FAILURE_MESSAGE,
  AI_AGENT_MISUNDERSTOOD_MESSAGE,
  AiAdminAgentService,
  doualaDayStart,
  periodBounds,
} from './ai-admin-agent.service.js';
import { AdminController } from '../admin/admin.controller.js';

/* IA-11 — Agent IA admin (lecture seule) : tool contrôlé, chiffres réels,
 * refus d'action, fail-open sans invention, ADMIN uniquement. Prisma +
 * Gateway mockés, aucun réseau, aucune écriture possible. */

function agentService(options: {
  enabled?: boolean;
  plan?: unknown;
  synthReply?: string | null;
  gatewayErrorOn?: 'plan' | 'synth' | null;
  overview?: unknown;
} = {}) {
  const gatewayInputs: unknown[] = [];
  let calls = 0;
  const gateway = {
    completeJson: vi.fn(async (input: unknown) => {
      gatewayInputs.push(input);
      calls += 1;
      const failOn = options.gatewayErrorOn;
      if ((failOn === 'plan' && calls === 1) || (failOn === 'synth' && calls === 2)) {
        throw Object.assign(new Error('amont indisponible'), { code: 'AI_UPSTREAM' });
      }
      if (calls === 1) return { result: options.plan ?? { tool: null, args: {} }, model: 'm', durationMs: 5 };
      return {
        result: options.synthReply === null || options.synthReply === undefined ? null : { reply: options.synthReply },
        model: 'm',
        durationMs: 5,
      };
    }),
  };
  const forbidden = { update: vi.fn(), delete: vi.fn(), create: vi.fn(), upsert: vi.fn() };
  const prisma = {
    technicianProfile: {
      count: vi.fn(async () => 20),
      groupBy: vi.fn(async () => [{ kycStatus: 'VERIFIED', _count: { _all: 15 } }]),
      ...forbidden,
    },
    demande: {
      count: vi.fn(async () => 3),
      groupBy: vi.fn(async () => [{ status: 'IN_PROGRESS', _count: { _all: 3 } }]),
      findMany: vi.fn(async () => []),
      ...forbidden,
    },
    demandeClassification: { count: vi.fn(async () => 1), ...forbidden },
    user: {
      count: vi.fn(async () => 5),
      groupBy: vi.fn(async () => [{ role: 'TECHNICIAN', _count: { _all: 5 } }]),
      ...forbidden,
    },
    review: { findMany: vi.fn(async () => []), ...forbidden },
  };
  const aiConfig = {
    isConfigured: () => options.enabled !== false,
    refusalReason: () => (options.enabled === false ? 'IA désactivée' : null),
    model: 'm',
    chatTimeoutMs: 8000,
    agentPlanMaxTokens: 800,
    agentSynthMaxTokens: 1500,
  };
  const overview = { getOverview: vi.fn(async () => options.overview ?? { warnings: { pending: 2 } }) };
  const service = new AiAdminAgentService(prisma as never, aiConfig as never, gateway as never, overview as never);
  return { service, gateway, gatewayInputs, prisma, forbidden };
}

describe('ADMIN uniquement — routes protégées par guards de classe', () => {
  it('chat + status exposés sous contrôleur ADMIN', () => {
    const roles = Reflect.getMetadata('roles', AdminController) as string[] | undefined;
    expect(roles).toEqual(['ADMIN']);
    const proto = AdminController.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.chatWithAiAgent).toBe('function');
    expect(typeof proto.getAiAgentStatus).toBe('function');
  });
});

describe('question de comptage — tool sélectionné, chiffres réels transmis', () => {
  it('techniciens disponibles → get_technicians → synthèse avec vrais chiffres', async () => {
    const { service, gatewayInputs } = agentService({
      plan: { tool: 'get_technicians', args: {} },
      synthReply: '14 techniciens sont actuellement disponibles.',
    });
    const result = await service.chat('Combien de techniciens sont disponibles actuellement ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_technicians', ok: true }]);
    expect(result.reply).toContain('14 techniciens');
    expect(result.model).toBe('m');
    // Le planificateur puis la synthèse : 2 appels, chiffres réels injectés.
    expect(gatewayInputs).toHaveLength(2);
    const synthInput = gatewayInputs[1] as { messages: Array<{ content: string }> };
    const payload = synthInput.messages.map((m) => m.content).join('\n');
    expect(payload).toContain('"available":20');
  });

  it('surveillance IA → get_overview réutilisé (aucun second système)', async () => {
    const { service, gatewayInputs } = agentService({
      plan: { tool: 'get_overview', args: {} },
      synthReply: '2 avertissements ouverts.',
      overview: { warnings: { pending: 2 }, conversationFlags: { open: 1 } },
    });
    const result = await service.chat('Combien d’avertissements sont ouverts ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_overview', ok: true }]);
    const synthInput = gatewayInputs[1] as { messages: Array<{ content: string }> };
    expect(synthInput.messages.map((m) => m.content).join('\n')).toContain('"pending":2');
  });
});

describe('donnée indisponible — signalée, jamais inventée', () => {
  it('plan sans tool → synthèse directe, pas de chiffre', async () => {
    const { service, gateway } = agentService({
      plan: { nimporte: 'quoi' },
      synthReply: 'Je peux décrire mes capacités.',
    });
    const result = await service.chat('blabla ???');
    expect(result.reply).toBe('Je peux décrire mes capacités.');
    expect(result.toolCalls).toEqual([]);
    expect(gateway.completeJson).toHaveBeenCalledTimes(2);
  });

  it('outil inconnu → message incompréhension, pas de synthèse', async () => {
    const { service, gateway } = agentService({ plan: { tool: 'drop_database', args: {} } });
    const result = await service.chat('blabla ???');
    expect(result.reply).toBe(AI_AGENT_MISUNDERSTOOD_MESSAGE);
    expect(result.toolCalls).toEqual([]);
    expect(gateway.completeJson).toHaveBeenCalledTimes(1);
  });

  it('synthèse vide → message d’échec, pas de chiffre', async () => {
    const { service } = agentService({ plan: { tool: null, args: {} }, synthReply: null });
    const result = await service.chat('Que sais-tu faire ?');
    expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
  });
});

describe('demande d’action — refus déterministe sans appel LLM', () => {
  it.each([
    'Suspend ce technicien.',
    'Supprime cet utilisateur.',
    'Modifie le prix de ce devis.',
    'Envoie un message au client.',
    'Annule cette mission.',
  ])('%s → refus + renvoi outils admin', async (question) => {
    const { service, gateway } = agentService({ synthReply: 'ne devrait jamais servir' });
    const result = await service.chat(question);
    expect(result.reply).toBe(AI_AGENT_ACTION_REFUSAL);
    expect(result.toolCalls).toEqual([]);
    expect(gateway.completeJson).not.toHaveBeenCalled();
  });

  it('question statistique contenant un participe ("annulées") → pas de refus', async () => {
    const { service } = agentService({
      plan: { tool: 'get_missions', args: { period: 'today' } },
      synthReply: '1 mission annulée.',
    });
    const result = await service.chat('Combien de missions annulées aujourd’hui ?');
    expect(result.toolCalls).toEqual([{ tool: 'get_missions', ok: true }]);
  });
});

describe('IA indisponible — message propre, chiffres jamais inventés', () => {
  it('désactivée → message dédié, aucun appel gateway', async () => {
    const { service, gateway } = agentService({ enabled: false });
    const result = await service.chat('Activité aujourd’hui ?');
    expect(result.reply).toBe(AI_AGENT_DISABLED_MESSAGE);
    expect(result.model).toBeNull();
    expect(gateway.completeJson).not.toHaveBeenCalled();
  });

  it.each([['plan', 'timeout'], ['synth', '429/5xx']] as Array<['plan' | 'synth', string]>)(
    'échec %s (%s) → message d’échec',
    async (failing) => {
      const { service } = agentService({ gatewayErrorOn: failing });
      const result = await service.chat('Techniciens disponibles ?');
      expect(result.reply).toBe(AI_AGENT_FAILURE_MESSAGE);
      expect(result.reply).not.toMatch(/\d+ techniciens sont/);
    },
  );
});

describe('aucune mutation — prisma en lecture seule', () => {
  it('toutes les questions → zéro update/delete/create/upsert', async () => {
    const { service, forbidden } = agentService({
      plan: { tool: 'get_technicians', args: {} },
      synthReply: 'ok',
    });
    await service.chat('Techniciens disponibles ?');
    await service.chat('Activité ?', [{ role: 'user', content: 'précédent' }]);
    for (const spy of Object.values(forbidden)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('aucun SQL libre dans le service agent', () => {
    const source = readFileSync(join(__dirname, 'ai-admin-agent.service.ts'), 'utf8');
    expect(source).not.toMatch(/\$queryRaw|\$executeRaw|prisma\.\$query/);
  });
});

describe('secrets — absents des payloads IA', () => {
  it('entrées gateway sans clé/JWT/mot de passe', async () => {
    const { service, gatewayInputs } = agentService({
      plan: { tool: 'get_users', args: { period: 'today' } },
      synthReply: '5 inscrits.',
    });
    await service.chat('Nouvelles inscriptions ?');
    const serialized = JSON.stringify(gatewayInputs);
    for (const leak of ['sk-or-', 'Bearer', 'password', 'Authorization', 'OPENROUTER_API_KEY']) {
      expect(serialized).not.toContain(leak);
    }
  });
});

describe('historique — borné, rôles validés', () => {
  it('>10 messages → seuls les 10 derniers transmis', async () => {
    const { service, gatewayInputs } = agentService({ plan: { tool: null, args: {} }, synthReply: 'ok' });
    const history = Array.from({ length: 15 }, (_, i) => ({ role: 'user' as const, content: `q${i}` }));
    await service.chat('Et maintenant ?', history);
    const planInput = gatewayInputs[0] as { messages: Array<{ content: string }> };
    const userContent = planInput.messages.find((m) => m.content.includes('Contexte récent'))?.content ?? '';
    expect(userContent).toContain('q14');
    expect(userContent).not.toContain('Admin : q4\n');
    expect(userContent).not.toContain('Admin : q0\n');
  });

  it('période invalide → today (valeur sûre)', async () => {
    const { service, gatewayInputs } = agentService({
      plan: { tool: 'get_demandes', args: { period: 'forever' } },
      synthReply: 'ok',
    });
    await service.chat('Demandes ?');
    expect(gatewayInputs).toHaveLength(2);
    const synthInput = gatewayInputs[1] as { messages: Array<{ content: string }> };
    expect(synthInput.messages.map((m) => m.content).join('\n')).toContain('"period":"today"');
  });
});

describe('périodes — bornes métier Douala (UTC+1 fixe)', () => {
  it('today = minuit Douala → minuit suivant, jamais locale navigateur', () => {
    // 2026-09-30T12:00:00Z = 13:00 à Douala.
    const now = new Date('2026-09-30T12:00:00.000Z');
    expect(doualaDayStart(now, 0).toISOString()).toBe('2026-09-29T23:00:00.000Z');
    const { from, to } = periodBounds('today', now);
    expect(from?.toISOString()).toBe('2026-09-29T23:00:00.000Z');
    expect(to?.toISOString()).toBe('2026-09-30T23:00:00.000Z');
    const yesterday = periodBounds('yesterday', now);
    expect(yesterday.from?.toISOString()).toBe('2026-09-28T23:00:00.000Z');
  });
});

describe('statut — disponibilité exposée sans secret', () => {
  it('désactivé → available false + motif, modèle null', async () => {
    const { service } = agentService({ enabled: false });
    expect(service.status()).toMatchObject({ available: false, model: null });
  });
});
