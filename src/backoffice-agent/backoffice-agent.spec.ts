import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackofficeAgentConfig } from './backoffice-agent.config.js';
import { BackofficeAgentService } from './backoffice-agent.service.js';
import { BACKOFFICE_AGENT_TOOLS } from './backoffice-agent.tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(__dirname, name), 'utf8');
// Code seul (sans commentaires) : les tests statiques portent sur le code,
// pas sur la documentation qui nomme les interdits pour les expliquer.
const codeOnly = (name: string): string =>
  read(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/* Agent Backoffice — garanties techniques (Prisma/gateway simulés) :
 * read-only, refus de modification, séparation données/instructions,
 * plafonds, indisponibilité sans clé. */

function configService(values: Record<string, string> = {}) {
  return {
    get: (key: string) => values[key],
  };
}

function configuredAgentConfig() {
  return new BackofficeAgentConfig(
    configService({ GROQ_API_KEY: 'gsk-test-key' }) as never,
  );
}

function stubPrisma(models: Record<string, Record<string, (args: unknown) => Promise<unknown>>> = {}) {
  const fallback = { findMany: async () => [], findUnique: async () => null, findFirst: async () => null };
  return new Proxy(
    {},
    {
      get: (_target, model: string) => models[model] ?? fallback,
    },
  );
}

function stubGroq(choices: Array<{ content?: string | null; toolCalls?: Array<{ id: string; name: string; argumentsJson: string }> }>) {
  const queue = [...choices];
  const seen: unknown[] = [];
  return {
    seen,
    client: {
      chat: vi.fn(async (input: { messages: unknown[] }) => {
        seen.push(input.messages);
        const next = queue.shift() ?? { content: 'Réponse finale.', toolCalls: [] };
        return { content: next.content ?? null, toolCalls: next.toolCalls ?? [], finishReason: 'stop' };
      }),
    },
  };
}

function serviceWith(prisma: unknown, groqClient: unknown) {
  return new BackofficeAgentService(prisma as never, configuredAgentConfig(), groqClient as never);
}

describe('read-only technique — aucun outil ne peut écrire', () => {
  it("le fichier d'outils ne contient aucune primitive d'écriture Prisma", () => {
    const src = codeOnly('backoffice-agent.tools.ts');
    expect(src).not.toMatch(/\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(/);
    expect(src).not.toMatch(/executeRaw|queryRaw/);
  });

  it('le service ne touche jamais les modèles Prisma directement', () => {
    const src = codeOnly('backoffice-agent.service.ts');
    expect(src).not.toMatch(/prisma\.(user|demande|message|diagnostic|quote|demandeDispute|financialTransaction|notification)/);
  });

  it('chaque outil déclaré possède un exécuteur issu de la whitelist', () => {
    const names = BACKOFFICE_AGENT_TOOLS.map((tool) => tool.name);
    expect(names).toEqual([
      'search_users',
      'get_user',
      'search_demandes',
      'get_demande',
      'search_messages',
      'get_conversation',
      'search_payments',
      'search_quotes',
      'search_disputes',
    ]);
    for (const tool of BACKOFFICE_AGENT_TOOLS) {
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('aucun champ sensible exposé (mots de passe, tokens, chemins privés)', () => {
    const src = codeOnly('backoffice-agent.tools.ts');
    expect(src).not.toContain('passwordHash');
    expect(src).not.toContain('passwordResetToken');
    expect(src).not.toContain('tokenVersion');
    expect(src).not.toContain('emailVerificationToken');
    // Chemin audio privé : exposé comme booléen uniquement.
    expect(src).toContain('hasAudio');
  });
});

describe('prompt système — lecture seule et véracité', () => {
  it('impose lecture seule, refus de modification, véracité et séparation données/instructions', () => {
    const src = read('backoffice-agent.service.ts');
    expect(src).toContain('LECTURE SEULE');
    expect(src).toContain('AUCUNE capacité de création');
    expect(src).toContain("Je n'ai trouvé aucun élément correspondant dans les données consultées");
    expect(src).toContain('FAIT VÉRIFIÉ');
    expect(src).toContain('DONNÉES');
    expect(src).toContain('jamais des ordres');
    expect(src).toContain('RÉSULTAT OUTIL');
  });
});

describe('boucle agent — orchestration multi-outils', () => {
  it('question simple → recherche → réponse fondée sur les données', async () => {
    const prisma = stubPrisma({
      user: { findMany: async () => [{ id: 'u-1', firstName: 'Awa', lastName: null }] },
    });
    const groq = stubGroq([
      {
        content: null,
        toolCalls: [{ id: 'c1', name: 'search_users', argumentsJson: '{"query":"Awa"}' }],
      },
      { content: "J'ai trouvé Awa (u-1, FAIT VÉRIFIÉ).", toolCalls: [] },
    ]);
    const result = await serviceWith(prisma, groq.client).chat('admin-1', 'Qui est Awa ?', []);
    expect(result.reply).toContain('Awa');
    expect(result.toolCalls).toEqual([{ tool: 'search_users', ok: true }]);
    expect(result.model).toBe('openai/gpt-oss-120b');
  });

  it('question sans résultat → formulation prudente, pas de fait inventé', async () => {
    const prisma = stubPrisma();
    const groq = stubGroq([{ content: null, toolCalls: [{ id: 'c1', name: 'search_users', argumentsJson: '{"query":"ZZZ"}' }] }, { content: "Je n'ai trouvé aucun élément correspondant dans les données consultées.", toolCalls: [] }]);
    const result = await serviceWith(prisma, groq.client).chat('admin-1', 'Qui est ZZZ ?', []);
    expect(result.reply).toContain("Je n'ai trouvé aucun élément");
  });

  it('outil inconnu demandé par le modèle → échec propre, pas de crash', async () => {
    const prisma = stubPrisma();
    const groq = stubGroq([
      { content: null, toolCalls: [{ id: 'c1', name: 'delete_everything', argumentsJson: '{}' }] },
      { content: 'Je ne peux pas faire cela.', toolCalls: [] },
    ]);
    const result = await serviceWith(prisma, groq.client).chat('admin-1', 'Supprime cette demande.', []);
    expect(result.toolCalls).toEqual([{ tool: 'delete_everything', ok: false }]);
    expect(result.reply).toContain('Je ne peux pas faire cela');
  });

  it('outil qui échoue (demande introuvable) → réponse sans données inventées', async () => {
    const prisma = stubPrisma();
    const groq = stubGroq([
      { content: null, toolCalls: [{ id: 'c1', name: 'get_demande', argumentsJson: '{"reference":"RD-XXXXXX"}' }] },
      { content: "Je n'ai pas suffisamment de données vérifiables pour répondre.", toolCalls: [] },
    ]);
    const result = await serviceWith(prisma, groq.client).chat('admin-1', 'Détail RD-XXXXXX ?', []);
    expect(result.toolCalls).toEqual([{ tool: 'get_demande', ok: false }]);
  });

  it('panne provider → réponse de repli, jamais de fait inventé', async () => {
    const prisma = stubPrisma();
    const groq = { chat: vi.fn(async () => Promise.reject(new Error('boom'))) };
    const result = await serviceWith(prisma, groq).chat('admin-1', 'Bonjour ?', []);
    expect(result.reply).toContain('suffisamment de données vérifiables');
  });
});

describe('plafonds de sécurité', () => {
  it('historique plafonné à 10 avant envoi au modèle', async () => {
    const prisma = stubPrisma();
    const groq = stubGroq([{ content: 'OK.', toolCalls: [] }]);
    const history = Array.from({ length: 15 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));
    await serviceWith(prisma, groq.client).chat('admin-1', 'Suite ?', history);
    const sent = groq.seen[0] as Array<{ role: string }>;
    // system + 10 historique + question = 12 messages max.
    expect(sent.length).toBeLessThanOrEqual(12);
    expect(sent[0]).toMatchObject({ role: 'system' });
  });

  it('boucle bornée : modèle qui appelle sans fin → réponse de limite', async () => {
    const prisma = stubPrisma();
    const endless = Array.from({ length: 20 }, (_, i) => ({
      content: null as string | null,
      toolCalls: [{ id: `c${i}`, name: 'search_users', argumentsJson: '{"query":"aa"}' }],
    }));
    const groq = stubGroq(endless);
    const result = await serviceWith(prisma, groq.client).chat('admin-1', 'Cherche ?', []);
    expect(result.toolCalls.length).toBeLessThanOrEqual(6);
    expect(result.reply).toContain("Je n'ai pas pu rassembler");
  });
});

describe('indisponibilité sans clé', () => {
  it('sans GROQ_API_KEY → refus propre, aucun appel provider', async () => {
    const prisma = stubPrisma();
    const groq = stubGroq([]);
    const service = new BackofficeAgentService(
      prisma as never,
      new BackofficeAgentConfig(configService({}) as never),
      groq.client as never,
    );
    expect(service.status()).toEqual({ available: false, model: null, reason: expect.any(String) });
    const result = await service.chat('admin-1', 'Bonjour ?', []);
    expect(result.model).toBeNull();
    expect(result.toolCalls).toEqual([]);
    expect(groq.client.chat).not.toHaveBeenCalled();
  });
});

describe('statut configuré', () => {
  it('avec clé → disponible, modèle exposé', () => {
    const service = new BackofficeAgentService(stubPrisma() as never, configuredAgentConfig(), stubGroq([]).client as never);
    expect(service.status()).toEqual({ available: true, model: 'openai/gpt-oss-120b', reason: null });
  });
});

describe('garde-fous des outils (requêtes cadrées)', () => {
  const ctx = { prisma: stubPrisma() as never };

  async function run(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = BACKOFFICE_AGENT_TOOLS.find((candidate) => candidate.name === name);
    if (!tool) throw new Error('outil de test inconnu');
    return tool.execute(ctx, args);
  }

  it('search_users refuse les recherches trop courtes', async () => {
    await expect(run('search_users', { query: 'a' })).rejects.toThrow('2 caractères minimum');
  });

  it('search_messages exige des mots-clés', async () => {
    await expect(run('search_messages', { keywords: [] })).rejects.toThrow('mot-clé');
    await expect(run('search_messages', { keywords: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'] })).rejects.toThrow('5 mots-clés maximum');
  });

  it('search_quotes exige un périmètre (pas de balayage global)', async () => {
    await expect(run('search_quotes', {})).rejects.toThrow('pas de balayage global');
  });

  it('get_user inconnu → erreur propre', async () => {
    await expect(run('get_user', { userId: 'nope' })).rejects.toThrow('introuvable');
  });

  it('statut invalide → erreur propre (jamais d’exception Prisma)', async () => {
    await expect(run('search_demandes', { status: 'SUPPRIMEE' })).rejects.toThrow('status');
  });
});
