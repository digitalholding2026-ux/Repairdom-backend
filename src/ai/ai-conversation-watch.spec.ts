import { describe, expect, it, vi } from 'vitest';
import {
  AI_CONVERSATION_CATEGORIES,
  AI_CONVERSATION_CONTEXT_MESSAGES,
  AI_CONVERSATION_MAX_MESSAGE_CHARS,
  AiConversationWatchService,
} from './ai-conversation-watch.service.js';

/* IA-8 — surveillance des conversations (Prisma + Gateway mockés) :
 * signal uniquement, jamais bloquant, jamais une sanction. Le message est
 * toujours conservé ; OpenRouter indisponible/invalide → aucun flag.
 * Aucun appel réseau. */

const MESSAGE = {
  id: 'msg-1',
  demandeId: 'd-1',
  senderId: 'tech-1',
  content: 'Bonjour, le diagnostic est prêt.',
  createdAt: new Date('2026-09-30T10:00:00Z'),
};

function watchService(options: {
  message?: Record<string, unknown> | null;
  sender?: Record<string, unknown> | null;
  existingFlag?: Record<string, unknown> | null;
  recent?: Array<Record<string, unknown>>;
  demande?: Record<string, unknown> | null;
  diagnostic?: Record<string, unknown> | null;
  quotes?: Array<Record<string, unknown>>;
  admins?: Array<{ id: string }>;
  flagCount?: number;
  flagRows?: Array<Record<string, unknown>>;
  reviewFlag?: Record<string, unknown> | null;
  gatewayResult?: unknown;
  gatewayError?: unknown;
  enabled?: boolean;
  minConfidence?: number;
} = {}) {
  const created: unknown[] = [];
  const notifications: unknown[] = [];
  const updated: unknown[] = [];
  const gatewayInputs: unknown[] = [];
  const gateway =
    options.gatewayError !== undefined
      ? {
          completeJson: vi.fn(async (input: unknown) => {
            gatewayInputs.push(input);
            throw options.gatewayError;
          }),
        }
      : {
          completeJson: vi.fn(async (input: unknown) => {
            gatewayInputs.push(input);
            return { result: options.gatewayResult ?? null, model: 'test-model', durationMs: 12 };
          }),
        };
  const aiConfig = {
    isConfigured: () => options.enabled !== false,
    refusalReason: () => (options.enabled === false ? 'IA désactivée (AI_ENABLED=false)' : null),
    chatMinConfidence: options.minConfidence ?? 0.7,
    chatTimeoutMs: 8000,
  };
  const baseFlag = {
    id: 'flag-1',
    demandeId: 'd-1',
    messageId: 'msg-1',
    senderId: 'tech-1',
    senderRole: 'TECHNICIAN',
    category: 'OFF_PLATFORM_PAYMENT',
    confidence: 0.91,
    severity: 'HIGH',
    reason: 'Proposition de règlement hors plateforme.',
    model: 'test-model',
    promptVersion: 1,
    status: 'OPEN',
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    createdAt: new Date('2026-09-30T10:05:00Z'),
    // eslint-disable-next-line unicorn/no-useless-fallback-in-spread -- `reviewFlag: null` simule l'absence (404), le fallback le distingue de `undefined`.
    ...(options.reviewFlag ?? {}),
  };
  const prisma = {
    message: {
      findUnique: vi.fn(async () => (options.message === undefined ? MESSAGE : options.message) as never),
      findMany: vi.fn(async () => (options.recent ?? [MESSAGE]) as never),
    },
    user: {
      findUnique: vi.fn(async () => (options.sender === undefined ? { id: 'tech-1', role: 'TECHNICIAN' } : options.sender) as never),
      findMany: vi.fn(async () => (options.admins ?? [{ id: 'admin-1' }]) as never),
    },
    aiConversationFlag: {
      findUnique: vi.fn(async (args: { where: { messageId?: string; id?: string } }) => {
        if (args.where.messageId) return (options.existingFlag ?? null) as never;
        if (args.where.id) {
          if (options.reviewFlag === null) return null as never;
          return { ...baseFlag } as never;
        }
        return null as never;
      }),
      findMany: vi.fn(async () => (options.flagRows ?? [{ ...baseFlag }]) as never),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { ...baseFlag, ...data, id: 'flag-new' } as never;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return { ...baseFlag, ...data } as never;
      }),
      count: vi.fn(async () => (options.flagCount ?? 0) as never),
    },
    demande: {
      findUnique: vi.fn(async () => {
        return (options.demande === undefined
          ? { id: 'd-1', reference: 'RD-000001', category: 'plomberie', status: 'IN_PROGRESS' }
          : options.demande) as never;
      }),
    },
    diagnostic: {
      findFirst: vi.fn(async () => (options.diagnostic === undefined ? null : options.diagnostic) as never),
    },
    quote: {
      findMany: vi.fn(async () => (options.quotes ?? []) as never),
    },
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        notifications.push(data);
        return { id: 'n-1', ...data } as never;
      }),
    },
  };
  return {
    service: new AiConversationWatchService(prisma as never, aiConfig as never, gateway as never),
    prisma,
    gateway,
    gatewayInputs,
    created,
    notifications,
    updated,
  };
}

function flaggedResult(category: string, confidence = 0.91, severity = 'HIGH') {
  return {
    flagged: true,
    category,
    confidence,
    severity,
    reason: 'Le message semble proposer un règlement hors plateforme.',
  };
}

describe('message normal → aucun flag', () => {
  it('flagged=false → rien de persisté, aucun appel admin', async () => {
    const { service, created, notifications } = watchService({
      gatewayResult: { flagged: false, category: 'OTHER', confidence: 0, severity: 'LOW', reason: '' },
    });
    expect(await service.analyzeMessage('msg-1')).toBeNull();
    expect(created).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });
});

describe('détection par catégories → flag correspondant', () => {
  it.each([
    ['OFF_PLATFORM_PAYMENT', 'Payez-moi directement en espèces, pas via Relio.'],
    ['OFF_PLATFORM_CONTACT', 'Contactez-moi sur WhatsApp au 6xx pour arranger ça.'],
    ['CONVERSATION_INCONSISTENCY', 'En fait le problème est tout autre que ce que j’avais dit.'],
    ['PRICE_DISCREPANCY', 'Finalement ce sera le double du devis, sans explication.'],
    ['POTENTIAL_FRAUD', 'Fausse facture et faux diagnostic pour gonfler le prix.'],
    ['ABUSIVE_OR_PRESSURING_BEHAVIOR', 'Payez immédiatement sinon j’abandonne la mission.'],
  ])('%s → flag OPEN persisté', async (category, content) => {
    const { service, created } = watchService({
      message: { ...MESSAGE, content },
      gatewayResult: flaggedResult(category, 0.9, category === 'ABUSIVE_OR_PRESSURING_BEHAVIOR' ? 'MEDIUM' : 'HIGH'),
    });
    const flag = (await service.analyzeMessage('msg-1')) as Record<string, unknown>;
    expect(flag).toMatchObject({ category, status: 'OPEN' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ messageId: 'msg-1', category, status: 'OPEN' });
  });

  it('OTHER reste une catégorie valide (jamais de phrase libre comme résultat)', async () => {
    const { service, created } = watchService({ gatewayResult: flaggedResult('OTHER', 0.8, 'LOW') });
    const flag = (await service.analyzeMessage('msg-1')) as Record<string, unknown>;
    expect(flag).toMatchObject({ category: 'OTHER' });
    expect(created).toHaveLength(1);
    expect(AI_CONVERSATION_CATEGORIES).toContain('OTHER');
  });
});

describe('confiance insuffisante → aucun flag', () => {
  it('sous le seuil centralisé → écarté sans persistance', async () => {
    const { service, created } = watchService({
      gatewayResult: flaggedResult('POTENTIAL_FRAUD', 0.42, 'HIGH'),
      minConfidence: 0.7,
    });
    expect(await service.analyzeMessage('msg-1')).toBeNull();
    expect(created).toHaveLength(0);
  });
});

describe('réponses IA inexploitables → message conservé, aucun flag', () => {
  it.each([
    ['JSON invalide (non-objet)', ['pas un objet']],
    ['catégorie inconnue', { flagged: true, category: 'BRAQUAGE', confidence: 0.9, severity: 'HIGH', reason: 'x' }],
    ['confiance absente', { flagged: true, category: 'OTHER', severity: 'LOW', reason: 'x' }],
    ['sévérité inconnue', { flagged: true, category: 'OTHER', confidence: 0.9, severity: 'CRITICAL', reason: 'x' }],
    ['flagged absent', { category: 'OTHER', confidence: 0.9, severity: 'LOW' }],
  ])('%s', async (_label, gatewayResult) => {
    const { service, created } = watchService({ gatewayResult });
    expect(await service.analyzeMessage('msg-1')).toBeNull();
    expect(created).toHaveLength(0);
  });
});

describe('OpenRouter indisponible → message conservé, aucun flag, jamais de throw', () => {
  it('IA désactivée → null sans appel gateway', async () => {
    const { service, gateway, created } = watchService({ enabled: false });
    expect(await service.analyzeMessage('msg-1')).toBeNull();
    expect(gateway.completeJson).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it.each([
    ['timeout', Object.assign(new Error('délai dépassé'), { code: 'AI_UPSTREAM' })],
    ['429 / 500', Object.assign(new Error('amont indisponible'), { code: 'AI_UPSTREAM' })],
    ['terminal 4xx', Object.assign(new Error('refus définitif'), { code: 'AI_TERMINAL' })],
    ['réponse invalide', Object.assign(new Error('JSON illisible'), { code: 'AI_INVALID_RESPONSE' })],
  ])('%s → null (best-effort)', async (_label, gatewayError) => {
    const { service, created } = watchService({ gatewayError });
    expect(await service.analyzeMessage('msg-1')).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('panne base à la création → null, jamais de throw vers le chat', async () => {
    const { service } = watchService({ gatewayResult: flaggedResult('OTHER', 0.9, 'LOW') });
    (service as unknown as { prisma: { aiConversationFlag: { create: unknown } } }).prisma.aiConversationFlag.create =
      vi.fn(async () => {
        throw new Error('panne base');
      }) as never;
    await expect(service.analyzeMessage('msg-1')).resolves.toBeNull();
  });

  it('message introuvable → null', async () => {
    const { service } = watchService({ message: null });
    expect(await service.analyzeMessage('msg-unknown')).toBeNull();
  });
});

describe('idempotence — même message analysé deux fois → pas de duplication', () => {
  it('flag existant → retourné sans nouvel appel gateway ni écriture', async () => {
    const existing = { id: 'flag-old', status: 'OPEN', category: 'OTHER' };
    const { service, gateway, prisma } = watchService({
      existingFlag: existing,
      gatewayResult: flaggedResult('POTENTIAL_FRAUD', 0.99, 'HIGH'),
    });
    expect(await service.analyzeMessage('msg-1')).toBe(existing);
    expect(gateway.completeJson).not.toHaveBeenCalled();
    expect(prisma.aiConversationFlag.create).not.toHaveBeenCalled();
  });

  it('doublon concurrent (P2002) → relit sans lever', async () => {
    const fallback = { id: 'flag-race', status: 'OPEN' };
    const gateway = { completeJson: vi.fn(async () => ({ result: flaggedResult('OTHER', 0.9, 'LOW'), model: 'm', durationMs: 1 })) };
    const prisma = {
      message: {
        findUnique: vi.fn(async () => MESSAGE as never),
        findMany: vi.fn(async () => [MESSAGE] as never),
      },
      user: { findUnique: vi.fn(async () => ({ id: 'tech-1', role: 'TECHNICIAN' }) as never), findMany: vi.fn(async () => [] as never) },
      aiConversationFlag: {
        findUnique: vi.fn(async (args: { where: { messageId?: string } }) =>
          (args.where.messageId ? (fallback as never) : null),
        ),
        create: vi.fn(async () => {
          const error = new Error('Unique constraint') as Error & { code: string };
          error.code = 'P2002';
          throw error;
        }),
      },
      demande: { findUnique: vi.fn(async () => ({ id: 'd-1', reference: 'RD-1', category: 'c', status: 'S' }) as never) },
      diagnostic: { findFirst: vi.fn(async () => null as never) },
      quote: { findMany: vi.fn(async () => [] as never) },
      notification: { create: vi.fn(async () => ({ id: 'n' }) as never) },
    };
    // Premier findUnique(messageId) → null (pas encore de flag), second → fallback.
    (prisma.aiConversationFlag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const service = new AiConversationWatchService(
      prisma as never,
      { isConfigured: () => true, refusalReason: () => null, chatMinConfidence: 0.7, chatTimeoutMs: 8000 } as never,
      gateway as never,
    );
    expect(await service.analyzeMessage('msg-1')).toBe(fallback);
  });
});

describe('review admin — OPEN → REVIEWED / DISMISSED, historique conservé', () => {
  it('OPEN → REVIEWED avec adminId, date et note', async () => {
    const { service, updated } = watchService();
    const now = new Date('2026-10-01T12:00:00Z');
    const result = (await service.reviewFlag('admin-1', 'flag-1', 'REVIEWED', 'Signal pertinent.', now)) as unknown as Record<string, unknown>;
    expect(updated[0]).toMatchObject({
      status: 'REVIEWED',
      reviewedBy: 'admin-1',
      reviewedAt: now,
      reviewNote: 'Signal pertinent.',
    });
    expect(result).toMatchObject({ status: 'REVIEWED' });
  });

  it('OPEN → DISMISSED sans supprimer', async () => {
    const { service, updated, prisma } = watchService();
    await service.reviewFlag('admin-1', 'flag-1', 'DISMISSED', 'Faux positif.');
    expect(updated[0]).toMatchObject({ status: 'DISMISSED' });
    expect(prisma.aiConversationFlag.update).toHaveBeenCalled();
  });

  it('déjà examiné → refus (pas de réécriture)', async () => {
    const { service } = watchService({ reviewFlag: { status: 'REVIEWED' } });
    await expect(service.reviewFlag('admin-1', 'flag-1', 'DISMISSED')).rejects.toThrow();
  });

  it('signal introuvable → 404', async () => {
    const { service } = watchService({ reviewFlag: null });
    await expect(service.reviewFlag('admin-1', 'flag-x', 'REVIEWED')).rejects.toThrow();
  });
});

describe('notifications admin — HIGH uniquement, jamais client/technicien/chat', () => {
  it('HIGH → notification CONVERSATION_FLAG aux admins actifs', async () => {
    const { service, notifications } = watchService({
      gatewayResult: flaggedResult('OFF_PLATFORM_PAYMENT', 0.91, 'HIGH'),
      admins: [{ id: 'admin-1' }, { id: 'admin-2' }],
    });
    await service.analyzeMessage('msg-1');
    expect(notifications).toHaveLength(2);
    for (const notif of notifications as Array<Record<string, unknown>>) {
      expect(notif).toMatchObject({ type: 'CONVERSATION_FLAG', demandeId: 'd-1' });
      expect(notif.userId).toMatch(/^admin-/);
    }
    const text = (notifications[0] as Record<string, unknown>).message as string;
    expect(text).toContain('OFF_PLATFORM_PAYMENT');
  });

  it('LOW/MEDIUM → aucun bruit admin (revue via liste)', async () => {
    for (const severity of ['LOW', 'MEDIUM']) {
      const { service, notifications } = watchService({
        gatewayResult: flaggedResult('OTHER', 0.85, severity),
      });
      const flag = (await service.analyzeMessage('msg-1')) as Record<string, unknown>;
      expect(flag).toMatchObject({ severity });
      expect(notifications).toHaveLength(0);
    }
  });
});

describe('minimisation — aucune donnée sensible envoyée au Gateway', () => {
  it('payload sans téléphone/email/adresse/GPS/KYC/soldes/secrets', async () => {
    const { service, gatewayInputs, prisma } = watchService({
      gatewayResult: { flagged: false, category: 'OTHER', confidence: 0, severity: 'LOW', reason: '' },
      demande: {
        id: 'd-1',
        reference: 'RD-000001',
        category: 'plomberie',
        status: 'IN_PROGRESS',
      },
      recent: [
        { id: 'msg-0', senderId: 'client-1', content: 'Appelez-moi au 690000000, mon email est x@y.z', createdAt: new Date() },
        MESSAGE,
      ],
    });
    await service.analyzeMessage('msg-1');
    expect(gatewayInputs).toHaveLength(1);
    const input = gatewayInputs[0] as { messages: Array<{ role: string; content: string }> };
    // Seules les colonnes métier minimales sont sélectionnées.
    const demandeSelect = (prisma.demande.findUnique.mock.calls[0][0] as { select: Record<string, boolean> }).select;
    for (const forbidden of ['contactPhone', 'address', 'latitude', 'longitude', 'clientId', 'technicianId']) {
      expect(demandeSelect).not.toHaveProperty(forbidden);
    }
    // Rôles uniquement (pas de noms/ids d'auteurs dans le contexte).
    const userPrompt = input.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userPrompt).not.toContain('tech-1');
    expect(userPrompt).not.toContain('client-1');
  });

  it('fenêtre de contexte bornée (pas de conversation intégrale)', async () => {
    const { prisma, service } = watchService({
      gatewayResult: { flagged: false, category: 'OTHER', confidence: 0, severity: 'LOW', reason: '' },
    });
    await service.analyzeMessage('msg-1');
    const calls = prisma.message.findMany.mock.calls as unknown[][];
    const args = (calls[0]?.[0] ?? {}) as { take?: number };
    expect(args.take).toBeLessThanOrEqual(AI_CONVERSATION_CONTEXT_MESSAGES + 1);
  });

  it('message courant tronqué avant envoi (payload borné)', async () => {
    const long = 'x'.repeat(AI_CONVERSATION_MAX_MESSAGE_CHARS + 500);
    const { service, gatewayInputs } = watchService({
      message: { ...MESSAGE, content: long },
      gatewayResult: { flagged: false, category: 'OTHER', confidence: 0, severity: 'LOW', reason: '' },
    });
    await service.analyzeMessage('msg-1');
    const input = gatewayInputs[0] as { messages: Array<{ content: string }> };
    for (const m of input.messages) {
      expect(m.content.length).toBeLessThan(8000);
    }
  });

  it('expéditeur ni CLIENT ni TECHNICIAN → ignoré', async () => {
    const { service, gateway, created } = watchService({
      sender: { id: 'admin-1', role: 'ADMIN' },
    });
    expect(await service.analyzeMessage('msg-1')).toBeNull();
    expect(gateway.completeJson).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});

describe('consultation admin — filtres et pagination', () => {
  it('retourne items + total + pages', async () => {
    const { service } = watchService({ flagCount: 3 });
    const result = (await service.getFlagsForAdmin({ status: 'OPEN', page: 1, limit: 20 })) as unknown as Record<string, unknown>;
    expect(result).toMatchObject({ total: 3, page: 1, limit: 20, pages: 1 });
    expect(result.items).toHaveLength(1);
  });
});
