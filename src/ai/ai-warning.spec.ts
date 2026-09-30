import { describe, expect, it, vi } from 'vitest';
import {
  AI_WARNING_JUSTIFICATION_DUE_HOURS,
  AiWarningService,
  effectiveWarningStatus,
  surveillanceLevelForCount,
} from './ai-warning.service.js';

/* IA-7 — avertissements tarifaires (Prisma mocké, 100 % déterministe) :
 * création sur ABOVE_MAX seul, justification 48 h backend, expiration LAZY
 * dérivée (aucun timer), niveaux 0/1/2/3 par comptage (jamais de LLM),
 * idempotence par pricingCheckId, propriété stricte, revue humaine.
 * Aucun appel réseau, aucun appel OpenRouter. */

function warningService(options: {
  existingWarning?: Record<string, unknown> | null;
  quote?: Record<string, unknown> | null;
  warning?: Record<string, unknown> | null;
  warnings?: Array<Record<string, unknown>>;
  count?: number;
  checkRow?: Record<string, unknown> | null;
} = {}) {
  const created: unknown[] = [];
  const notifications: unknown[] = [];
  const updated: unknown[] = [];
  const baseWarning = {
    id: 'w-1',
    technicianId: 'tech-1',
    demandeId: 'd-1',
    quoteId: 'q-1',
    diagnosticId: 'dg-1',
    pricingCheckId: 'chk-1',
    warningType: 'PRICE_ABOVE_MAX',
    status: 'PENDING',
    dueAt: new Date('2026-09-30T10:00:00Z'),
    justification: null,
    justifiedAt: null,
    isLateJustification: false,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    createdAt: new Date('2026-09-28T10:00:00Z'),
    // eslint-disable-next-line unicorn/no-useless-fallback-in-spread -- `warning: null` simule l'absence (404), le fallback le distingue de `undefined`.
    ...(options.warning ?? {}),
  };
  const prisma = {
    aiWarning: {
      findUnique: vi.fn(async (args: { where: { pricingCheckId?: string; id?: string } }) => {
        if (args.where.pricingCheckId) return (options.existingWarning ?? null) as never;
        if (args.where.id) {
          if (options.warning === null) return null as never;
          return { ...baseWarning } as never;
        }
        return null as never;
      }),
      findMany: vi.fn(async () => (options.warnings ?? [{ ...baseWarning }]) as never),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { ...baseWarning, ...data, id: 'w-new' } as never;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return { ...baseWarning, ...data } as never;
      }),
      count: vi.fn(async () => (options.count ?? 0) as never),
    },
    quote: {
      findUnique: vi.fn(
        async () => (options.quote ?? { id: 'q-1', technicianId: 'tech-1', amount: 85000 }) as never,
      ),
    },
    quotePricingCheck: {
      findUnique: vi.fn(async () => (options.checkRow ?? null) as never),
    },
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        notifications.push(data);
        return { id: 'n-1', ...data } as never;
      }),
    },
  };
  return { service: new AiWarningService(prisma as never), prisma, created, notifications, updated };
}

const ABOVE_MAX_CHECK = {
  id: 'chk-1',
  quoteId: 'q-1',
  demandeId: 'd-1',
  diagnosticId: 'dg-1',
  result: 'ABOVE_MAX',
};

describe('création — ABOVE_MAX → PENDING + 48 h, autres résultats → rien', () => {
  it('ABOVE_MAX crée un avertissement PENDING avec échéance 48 h backend', async () => {
    const { service, created, notifications } = warningService();
    const before = Date.now();
    const warning = (await service.ensureWarningForCheck(ABOVE_MAX_CHECK)) as Record<string, unknown>;
    const after = Date.now();
    expect(warning).toMatchObject({ warningType: 'PRICE_ABOVE_MAX', status: 'PENDING' });
    expect(created).toHaveLength(1);
    const data = created[0] as Record<string, unknown>;
    const dueAt = (data.dueAt as Date).getTime();
    expect(dueAt - before).toBeGreaterThanOrEqual(
      AI_WARNING_JUSTIFICATION_DUE_HOURS * 3600_000 - 1000,
    );
    expect(dueAt - after).toBeLessThanOrEqual(AI_WARNING_JUSTIFICATION_DUE_HOURS * 3600_000 + 1000);
    // Notification technicien via infra existante, message factuel (montants,
    // 48 h, poursuite normale — aucun terme accusatoire).
    expect(notifications).toHaveLength(1);
    const notif = notifications[0] as Record<string, unknown>;
    expect(notif).toMatchObject({ type: 'PRICING_WARNING' });
    const message = notif.message as string;
    expect(message).toMatch(/48 h/);
    expect(message).toMatch(/poursuivre/i);
    for (const banned of ['frauduleux', 'abusif', 'malhonnête', 'interdit']) {
      expect(message.toLowerCase()).not.toContain(banned);
    }
  });

  it.each(['NORMAL', 'BELOW_MIN', 'NO_BAREME', 'UNCERTAIN'])('%s → aucun avertissement', async (result) => {
    const { service, prisma } = warningService();
    expect(
      await service.ensureWarningForCheck({ ...ABOVE_MAX_CHECK, result }),
    ).toBeNull();
    expect(prisma.aiWarning.create).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('BELOW_MIN ne produit jamais un faux warning ABOVE_MAX', async () => {
    const { service, created } = warningService();
    await service.ensureWarningForCheck({ ...ABOVE_MAX_CHECK, result: 'BELOW_MIN' });
    expect(created).toHaveLength(0);
  });
});

describe('idempotence — même événement IA-6 → un seul avertissement', () => {
  it('contrôle déjà averti → existant retourné sans écriture', async () => {
    const existing = { id: 'w-old', status: 'PENDING' };
    const { service, prisma } = warningService({ existingWarning: existing });
    expect(await service.ensureWarningForCheck(ABOVE_MAX_CHECK)).toBe(existing);
    expect(prisma.aiWarning.create).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('doublon concurrent (P2002) → relit sans lever', async () => {
    const fallback = { id: 'w-race', status: 'PENDING' };
    const prisma = {
      aiWarning: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(fallback as never),
        create: vi.fn(async () => {
          const error = new Error('Unique constraint') as Error & { code: string };
          error.code = 'P2002';
          throw error;
        }),
      },
      quote: {
        findUnique: vi.fn(async () => ({ id: 'q-1', technicianId: 'tech-1', amount: 85000 }) as never),
      },
      quotePricingCheck: { findUnique: vi.fn(async () => null as never) },
      notification: { create: vi.fn(async () => ({ id: 'n-1' }) as never) },
    };
    const service = new AiWarningService(prisma as never);
    expect(await service.ensureWarningForCheck(ABOVE_MAX_CHECK)).toBe(fallback);
  });
});

describe('justification — propriétaire PENDING → JUSTIFIED horodaté', () => {
  it('texte valide → JUSTIFIED avec date serveur', async () => {
    const { service, updated } = warningService();
    const now = new Date('2026-09-29T10:00:00Z');
    const result = (await service.justifyWarning(
      'tech-1',
      'w-1',
      'Difficulté particulière : pièce supplémentaire et déplacement exceptionnel.',
      now,
    )) as unknown as Record<string, unknown>;
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      status: 'JUSTIFIED',
      justifiedAt: now,
      isLateJustification: false,
    });
    expect(result).toMatchObject({ storedStatus: 'JUSTIFIED', status: 'JUSTIFIED' });
  });

  it('autre technicien → accès refusé', async () => {
    const { service } = warningService();
    await expect(service.justifyWarning('tech-2', 'w-1', 'Justification assez longue ici.')).rejects.toThrow();
  });

  it('texte trop court → refus', async () => {
    const { service } = warningService();
    await expect(service.justifyWarning('tech-1', 'w-1', 'court')).rejects.toThrow();
  });
});

describe('expiration LAZY — PENDING + 48 h → EXPIRED dérivé, sans timer', () => {
  it('avant échéance → PENDING ; après → EXPIRED (jamais persisté)', () => {
    const dueAt = new Date('2026-09-30T10:00:00Z');
    expect(effectiveWarningStatus({ status: 'PENDING', dueAt }, new Date('2026-09-30T09:59:59Z'))).toBe(
      'PENDING',
    );
    expect(effectiveWarningStatus({ status: 'PENDING', dueAt }, new Date('2026-09-30T10:00:00Z'))).toBe(
      'EXPIRED',
    );
    expect(effectiveWarningStatus({ status: 'PENDING', dueAt }, new Date('2026-10-05T00:00:00Z'))).toBe(
      'EXPIRED',
    );
  });

  it('JUSTIFIED et REVIEWED ne basculent jamais en EXPIRED', () => {
    const dueAt = new Date('2026-09-30T10:00:00Z');
    const far = new Date('2027-01-01T00:00:00Z');
    expect(effectiveWarningStatus({ status: 'JUSTIFIED', dueAt }, far)).toBe('JUSTIFIED');
    expect(effectiveWarningStatus({ status: 'REVIEWED', dueAt }, far)).toBe('REVIEWED');
  });

  it('justification tardive → enregistrée et marquée tardive', async () => {
    const { service, updated } = warningService();
    const late = new Date('2026-10-05T00:00:00Z');
    const result = (await service.justifyWarning(
      'tech-1',
      'w-1',
      'Intervention complexe ayant nécessité davantage de temps sur place.',
      late,
    )) as unknown as Record<string, unknown>;
    expect(updated[0]).toMatchObject({ status: 'JUSTIFIED', isLateJustification: true });
    expect(result).toMatchObject({ isLateJustification: true });
  });
});

describe('revue admin — décision humaine conservée, événement intact', () => {
  it('PENDING → REVIEWED avec adminId, date et note', async () => {
    const { service, updated } = warningService();
    const now = new Date('2026-10-01T12:00:00Z');
    const result = (await service.reviewWarning('admin-1', 'w-1', 'Justification cohérente.', now)) as unknown as Record<string, unknown>;
    expect(updated[0]).toMatchObject({
      status: 'REVIEWED',
      reviewedBy: 'admin-1',
      reviewedAt: now,
      reviewNote: 'Justification cohérente.',
    });
    expect(result).toMatchObject({ storedStatus: 'REVIEWED', status: 'REVIEWED' });
  });

  it('avertissement déjà examiné → refus (pas de réécriture)', async () => {
    const { service } = warningService({ warning: { status: 'REVIEWED' } });
    await expect(service.reviewWarning('admin-1', 'w-1')).rejects.toThrow();
  });
});

describe('récidive — niveaux déterministes par comptage ABOVE_MAX', () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 3],
    [10, 3],
  ])('%i avertissement(s) → niveau %i', (count, level) => {
    expect(surveillanceLevelForCount(count)).toBe(level);
  });

  it('getSurveillanceLevel compte les PRICE_ABOVE_MAX (jamais de LLM)', async () => {
    const { service, prisma } = warningService({ count: 4 });
    expect(await service.getSurveillanceLevel('tech-1')).toBe(3);
    expect(prisma.aiWarning.count).toHaveBeenCalledWith({
      where: { technicianId: 'tech-1', warningType: 'PRICE_ABOVE_MAX' },
    });
  });

  it('niveau 3 = réexamen humain, pas de suspension (aucun effet de bord)', async () => {
    const { service, prisma } = warningService({ count: 7 });
    expect(await service.getSurveillanceLevel('tech-1')).toBe(3);
    // Le service ne touche ni aux devis, ni au ledger, ni aux suspensions :
    // seules les tables AI/notifications sont manipulées.
    expect(prisma).not.toHaveProperty('quote.update');
    expect(prisma).not.toHaveProperty('financialTransaction');
  });
});

describe('non-blocage — IA-7 ne modifie jamais le workflow métier', () => {
  it('ensureWarningForCheck ne lève jamais vers IA-6 (best-effort)', async () => {
    const prisma = {
      aiWarning: {
        findUnique: vi.fn(async () => null as never),
        create: vi.fn(async () => {
          throw new Error('panne base');
        }),
      },
      quote: {
        findUnique: vi.fn(async () => ({ id: 'q-1', technicianId: 'tech-1', amount: 1 }) as never),
      },
      quotePricingCheck: { findUnique: vi.fn(async () => null as never) },
      notification: { create: vi.fn(async () => ({ id: 'n-1' }) as never) },
    };
    const service = new AiWarningService(prisma as never);
    await expect(service.ensureWarningForCheck(ABOVE_MAX_CHECK)).resolves.toBeNull();
  });
});
