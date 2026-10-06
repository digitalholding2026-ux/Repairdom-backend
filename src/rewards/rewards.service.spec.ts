import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { RewardsService } from './rewards.service.js';
import type { RewardsNotificationsService } from './rewards-notifications.service.js';

/* Chantier #4A — comptage des récompenses (Prisma simulé EN MÉMOIRE).
 *
 * On ne mocke pas chaque appel Prisma individuellement : on implémente le
 * sous-ensemble de requêtes réellement utilisées par `RewardsService`
 * (`findUnique`, `findFirst`, `findMany`, `upsert`, `update`, `updateMany`,
 * `create`) sur des Maps, ce qui permet d'exprimer des scénarios réels
 * (compteur qui s'incrémente réellement, `upsert` qui crée la première ligne,
 * `updateMany` gardé qui refuse un second traitement) plutôt que d'empiler des
 * `vi.fn()` qui ne vérifient rien.
 *
 * Aucun accès réseau, aucune base : c'est un test unitaire pur. */

type Row = Record<string, any>;

function world(seed: {
  demandes?: Row[];
  progress?: Row[];
  flags?: Row[];
  users?: Record<string, Row>;
} = {}) {
  const demandes = new Map<string, Row>((seed.demandes ?? []).map((d) => [d.id, { ...d }]));
  const progress = new Map<string, Row>();
  for (const row of seed.progress ?? []) progress.set(row.userId, { ...row });
  const flags = new Map<string, Row>((seed.flags ?? []).map((f) => [f.id, { ...f }]));
  const users = new Map<string, Row>(
    Object.entries(seed.users ?? { c1: { id: 'c1', firstName: 'Awa', email: 'awa@test.cm' } }).map(
      ([id, u]) => [id, { ...u, id }],
    ),
  );

  let flagSeq = 0;

  const prisma = {
    demande: {
      findUnique: ({ where }: any) => demandes.get(where.id) ?? null,
      /* `orderBy: { updatedAt: 'desc' }` + filtres simples : suffisant pour le
       * service, qui ne fait qu'une requête de « mission CONFIRMED
       * précédente ». */
      findFirst: ({ where, orderBy }: any) => {
        const rows = [...demandes.values()].filter((d) => {
          if (where.clientId && d.clientId !== where.clientId) return false;
          if (where.id?.not && d.id === where.id.not) return false;
          if (where.status && d.status !== where.status) return false;
          if (where.updatedAt?.lt && !(d.updatedAt < where.updatedAt.lt)) return false;
          return true;
        });
        rows.sort((a, b) => (orderBy?.updatedAt === 'desc' ? b.updatedAt - a.updatedAt : 0));
        return rows[0] ?? null;
      },
    },
    user: {
      findUnique: ({ where, select }: any) => {
        const user = users.get(where.id);
        if (!user) return null;
        return select ? pick(user, Object.keys(select)) : user;
      },
    },
    clientRewardProgress: {
      findUnique: ({ where }: any) => progress.get(where.userId) ?? null,
      upsert: ({ where, create, update }: any) => {
        const existing = progress.get(where.userId);
        if (existing) {
          const merged = {
            ...existing,
            missionCount: existing.missionCount + (update.missionCount?.increment ?? 0),
            lastMissionAt: update.lastMissionAt ?? existing.lastMissionAt,
          };
          progress.set(where.userId, merged);
          return merged;
        }
        const created = { id: `p-${progress.size + 1}`, updatedAt: new Date(), ...create };
        progress.set(where.userId, created);
        return created;
      },
      update: ({ where, data }: any) => {
        const existing = progress.get(where.userId);
        if (!existing) throw new Error('P2025: progression absente');
        const updated = { ...existing, ...data, updatedAt: new Date() };
        progress.set(where.userId, updated);
        return updated;
      },
    },
    rewardFraudFlag: {
      findUnique: ({ where, include }: any) => {
        const flag = [...flags.values()].find((f) => {
          if (where.demandeId) return f.demandeId === where.demandeId;
          if (where.id) return f.id === where.id;
          return false;
        });
        if (!flag) return null;
        /* `include: { demande: ... }` est résolu comme en base : la décision
         * administrative a besoin de la référence et du montant de la mission. */
        if (include?.demande) {
          const d = demandes.get(flag.demandeId);
          if (!d) return null;
          return {
            ...flag,
            demande: include.demande.select ? pick(d, Object.keys(include.demande.select)) : d,
          };
        }
        return flag;
      },
      create: ({ data, select }: any) => {
        /* Unicité `demandeId` reproduite comme en base : la collision lève une
         * erreur `P2002`, ce qui permet de tester la course entre deux
         * traitements. */
        for (const flag of flags.values()) {
          if (flag.demandeId === data.demandeId) {
            const error: Row = new Error('Unique constraint failed');
            error.code = 'P2002';
            throw error;
          }
        }
        flagSeq += 1;
        const created = {
          id: `f${flagSeq}`,
          detectedAt: new Date(),
          resolvedAt: null,
          resolvedBy: null,
          decision: null,
          note: null,
          ...data,
        };
        flags.set(created.id, created);
        return select ? pick(created, Object.keys(select)) : created;
      },
      updateMany: ({ where, data }: any) => {
        let count = 0;
        for (const [id, flag] of flags) {
          /* Le `where` gardé (`resolvedAt: null`) est ce qui rend la décision
           * atomique : un dossier déjà tranché n'est pas recompté. */
          if (where.id && flag.id !== where.id) continue;
          if (where.resolvedAt === null && flag.resolvedAt !== null) continue;
          flags.set(id, { ...flag, ...data });
          count += 1;
        }
        return { count };
      },
      findMany: ({ where, take }: any) => {
        let rows = [...flags.values()];
        if (where?.resolvedAt === null) rows = rows.filter((f) => f.resolvedAt === null);
        if (where?.resolvedAt?.not !== undefined) rows = rows.filter((f) => f.resolvedAt !== null);
        rows.sort((a, b) => b.detectedAt - a.detectedAt);
        rows = rows.slice(0, take ?? 50);
        return rows.map((f) => ({
          ...f,
          demande: demandes.get(f.demandeId) ?? null,
          user: users.get(f.userId) ?? { firstName: '?', lastName: null, email: '?' },
          technician: users.get(f.technicianId) ?? { firstName: '?', lastName: null },
        }));
      },
    },
  } as unknown as PrismaService;

  return { prisma, demandes, progress, flags, users };
}

/** Raccourci typé : dans ces scénarios la ligne de progression DOIT exister.
 *  Sans cette assertion, `Map.get` renvoie `Row | undefined` et chaque
 *  expectation porterait un `!` — on préfère un échec de test explicite. */
function prog(w: { progress: Map<string, Row> }, userId = 'c1'): Row {
  const row = w.progress.get(userId);
  if (!row) throw new Error(`progression absente pour ${userId}`);
  return row;
}

/** Idem pour un signalement. */
function flagOf(w: { flags: Map<string, Row> }, id = 'f1'): Row {
  const row = w.flags.get(id);
  if (!row) throw new Error(`signalement ${id} absent`);
  return row;
}

function pick(source: Row, keys: string[]): Row {
  const out: Row = {};
  for (const key of keys) out[key] = source[key];
  return out;
}

function confirmed(overrides: Row = {}): Row {
  return {
    id: 'm1',
    reference: 'RD-ABC123',
    clientId: 'c1',
    technicianId: 't1',
    status: 'CONFIRMED',
    finalAmount: 20_000,
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
}

/** Double de `RewardsNotificationsService` qui enregistre les appels. */
function notificationsSpy() {
  return {
    notifyTierReached: vi.fn().mockResolvedValue(undefined),
    notifyMissionNotCounted: vi.fn().mockResolvedValue(undefined),
    publishProgressChanged: vi.fn(),
  } as unknown as RewardsNotificationsService & {
    notifyTierReached: ReturnType<typeof vi.fn>;
    notifyMissionNotCounted: ReturnType<typeof vi.fn>;
    publishProgressChanged: ReturnType<typeof vi.fn>;
  };
}

describe('RewardsService.onMissionConfirmed — règle de comptage', () => {
  it('ignore une mission dont le montant payé est sous le minimum', async () => {
    const w = world({ demandes: [confirmed({ finalAmount: 1_499 })] });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const outcome = await service.onMissionConfirmed('m1');

    expect(outcome.counted).toBe(false);
    expect(outcome.reason).toBe('AMOUNT_BELOW_MINIMUM');
    expect(w.progress.size).toBe(0);
  });

  it('compte une mission payée exactement 1 500 XAF (montant plancher inclus)', async () => {
    const w = world({ demandes: [confirmed({ finalAmount: 1_500 })] });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const outcome = await service.onMissionConfirmed('m1');

    expect(outcome.counted).toBe(true);
    expect(prog(w).missionCount).toBe(1);
  });

  it('incrémente le compteur mission après mission', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', reference: 'RD-AAA111', updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({
          id: 'm2',
          reference: 'RD-BBB222',
          technicianId: 't2',
          updatedAt: new Date('2026-10-05T10:00:00Z'),
        }),
        confirmed({
          id: 'm3',
          reference: 'RD-CCC333',
          technicianId: 't3',
          updatedAt: new Date('2026-10-09T10:00:00Z'),
        }),
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    await service.onMissionConfirmed('m1');
    await service.onMissionConfirmed('m2');
    const outcome = await service.onMissionConfirmed('m3');

    expect(outcome.counted).toBe(true);
    expect(prog(w).missionCount).toBe(3);
  });

  it('ignore une mission qui n’est pas CONFIRMED (défense en profondeur)', async () => {
    const w = world({ demandes: [confirmed({ status: 'COMPLETED' })] });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const outcome = await service.onMissionConfirmed('m1');

    expect(outcome).toEqual({ counted: false, reason: 'NOT_CONFIRMED' });
    expect(w.progress.size).toBe(0);
  });

  it('ignore une mission introuvable sans lever', async () => {
    const w = world();
    const service = new RewardsService(w.prisma, notificationsSpy());

    const outcome = await service.onMissionConfirmed('inconnue');

    expect(outcome).toEqual({ counted: false, reason: 'DEMANDE_NOT_FOUND' });
  });

  it('crée la ligne de progression à la première mission comptée', async () => {
    const w = world({ demandes: [confirmed()] });
    const service = new RewardsService(w.prisma, notificationsSpy());

    await service.onMissionConfirmed('m1');

    const row = prog(w);
    expect(row.missionCount).toBe(1);
    expect(row.currentTier).toBe('NONE');
    expect(row.reachedTiers).toEqual([]);
    expect(row.lastMissionAt).toEqual(new Date('2026-10-01T10:00:00Z'));
  });
});

describe('RewardsService — paliers', () => {
  /* Helper : place le compteur à N-1 missions avec les paliers cohérents, puis
   * compte une mission de plus. */
  function atMission(count: number) {
    const reachedTiers = (['BRONZE', 'ARGENT', 'OR', 'PLATINE'] as const).filter(
      (tier) =>
        ({ BRONZE: 15, ARGENT: 50, OR: 150, PLATINE: 500 })[tier] <= count,
    );
    return {
      id: 'p1',
      userId: 'c1',
      missionCount: count,
      currentTier: reachedTiers[reachedTiers.length - 1] ?? 'NONE',
      reachedTiers: [...reachedTiers],
      claimedTiers: [],
      lastMissionAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it('franchit BRONZE à la 15ᵉ mission et notifie sur les 4 canaux', async () => {
    const w = world({ demandes: [confirmed()], progress: [atMission(14)] });
    const notifications = notificationsSpy();
    const service = new RewardsService(w.prisma, notifications);

    const outcome = await service.onMissionConfirmed('m1');

    expect(outcome.counted).toBe(true);
    expect(outcome.tiersReached).toEqual(['BRONZE']);
    expect(prog(w).currentTier).toBe('BRONZE');
    expect(prog(w).reachedTiers).toEqual(['BRONZE']);

    /* Le service de notifications est le SEUL chemin vers les 4 canaux : c'est
     * lui qui est testé dans `rewards-notifications.spec.ts` (in-app, SSE,
     * push, e-mail). */
    expect(notifications.notifyTierReached).toHaveBeenCalledTimes(1);
    const [userId, firstName, tier, nextTier] = notifications.notifyTierReached.mock.calls[0];
    expect(userId).toBe('c1');
    expect(firstName).toBe('Awa');
    expect(tier.tier).toBe('BRONZE');
    expect(tier.rewardValueXAF).toBe(5_000);
    /* « Encore X missions pour ARGENT » : le client sait où il va. */
    expect(nextTier).toEqual(
      expect.objectContaining({ tier: 'ARGENT', remaining: 35 }),
    );
  });

  it('ne NOTIFIE PAS et ne rebranche pas un palier déjà atteint', async () => {
    const w = world({ demandes: [confirmed()], progress: [atMission(20)] });
    const notifications = notificationsSpy();
    const service = new RewardsService(w.prisma, notifications);

    const outcome = await service.onMissionConfirmed('m1');

    expect(outcome.tiersReached).toEqual([]);
    expect(notifications.notifyTierReached).not.toHaveBeenCalled();
    expect(prog(w).reachedTiers).toEqual(['BRONZE']);
  });

  it('ne franchit rien à la 14ᵉ mission (une mission avant BRONZE)', async () => {
    const w = world({ demandes: [confirmed()], progress: [atMission(13)] });
    const notifications = notificationsSpy();
    const service = new RewardsService(w.prisma, notifications);

    const outcome = await service.onMissionConfirmed('m1');

    expect(outcome.tiersReached).toEqual([]);
    expect(notifications.notifyTierReached).not.toHaveBeenCalled();
    expect(prog(w).currentTier).toBe('NONE');
  });

  it('franchit ARGENT à la 50ᵉ mission et met le niveau courant à jour', async () => {
    const w = world({ demandes: [confirmed()], progress: [atMission(49)] });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const outcome = await service.onMissionConfirmed('m1');

    expect(outcome.tiersReached).toEqual(['ARGENT']);
    expect(prog(w).currentTier).toBe('ARGENT');
    /* BRONZE n'est pas perdu : un palier atteint ne se reperd pas. */
    expect(prog(w).reachedTiers).toEqual(['BRONZE', 'ARGENT']);
  });

  it('signale la progression en temps réel même sans palier franchi', async () => {
    const w = world({ demandes: [confirmed()], progress: [atMission(5)] });
    const notifications = notificationsSpy();
    const service = new RewardsService(w.prisma, notifications);

    await service.onMissionConfirmed('m1');

    expect(notifications.publishProgressChanged).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ missionCount: 6, currentTier: 'NONE' }),
    );
  });

  it('ne fait JAMAIS échouer le comptage si la notification lève', async () => {
    const w = world({ demandes: [confirmed()], progress: [atMission(14)] });
    const notifications = notificationsSpy();
    notifications.notifyTierReached.mockRejectedValue(new Error('push indisponible'));
    const service = new RewardsService(w.prisma, notifications);

    const outcome = await service.onMissionConfirmed('m1');

    /* Le compteur prime toujours sur la notification. */
    expect(outcome.counted).toBe(true);
    expect(prog(w).missionCount).toBe(15);
  });
});

describe('RewardsService — anti-fraude (même technicien < 48 h)', () => {
  it('ouvre un signalement et NE COMPTE PAS la 2ᵉ mission', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', reference: 'RD-AAA111', updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', reference: 'RD-BBB222', updatedAt: new Date('2026-10-01T20:00:00Z') }),
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    // 1ʳᵉ mission : comptée normalement.
    await service.onMissionConfirmed('m1');
    // 2ᵉ mission, même technicien, 10 h plus tard : signalée, NON comptée.
    const outcome = await service.onMissionConfirmed('m2');

    expect(outcome.counted).toBe(false);
    expect(outcome.reason).toBe('FRAUD_FLAGGED');
    expect(outcome.flagId).toBe('f1');

    /* Le compteur n'avance pas : il reste sur la seule 1ʳᵉ mission. */
    expect(prog(w).missionCount).toBe(1);
    expect(w.flags.size).toBe(1);
    expect(flagOf(w)).toEqual(
      expect.objectContaining({
        userId: 'c1',
        demandeId: 'm2',
        technicianId: 't1',
        reason: 'SAME_TECHNICIAN_48H',
        resolvedAt: null,
        decision: null,
      }),
    );
  });

  it('compte normalement au-delà de 48 h avec le même technicien', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', updatedAt: new Date('2026-10-03T10:00:01Z') }),
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    await service.onMissionConfirmed('m1');
    const outcome = await service.onMissionConfirmed('m2');

    expect(outcome.counted).toBe(true);
    expect(w.flags.size).toBe(0);
    expect(prog(w).missionCount).toBe(2);
  });

  it('compte normalement avec un technicien différent dans la fenêtre', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', technicianId: 't1', updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', technicianId: 't2', updatedAt: new Date('2026-10-01T12:00:00Z') }),
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const outcome = await service.onMissionConfirmed('m2');

    expect(outcome.counted).toBe(true);
    expect(w.flags.size).toBe(0);
  });

  it("compare à la dernière mission CONFIRMED, même si celle-ci a été écartée", async () => {
    /* m1 (t1, −24 h) comptée, m2 (t1, −1 h) signalée et non comptée, puis m3
     * (t1, T).
     *
     * COMPORTEMENT SPÉCIFIÉ : la référence est « la mission CONFIRMED
     * précédente », sans condition de comptage. m2 reste donc la référence
     * pour m3, et m3 est signalée à son tour.
     *
     * C'est voulu, et c'est à garder en tête : tant que le même technicien est
     * ré-affecté au client, CHAQUE mission successive est signalée, donc gelée.
     * Un admin tranche les dossiers (ou le client change de technicien, ce qu'on
     * ne peut pas imposer). Ce qui est garanti dans tous les cas : le compteur
     * ne bouge pas, aucune mission gelée n'est comptée. */
    const w = world({
      demandes: [
        confirmed({ id: 'm1', technicianId: 't1', updatedAt: new Date('2026-10-09T11:00:00Z') }),
        confirmed({ id: 'm2', technicianId: 't1', updatedAt: new Date('2026-10-10T11:00:00Z') }),
        confirmed({ id: 'm3', technicianId: 't1', updatedAt: new Date('2026-10-10T12:00:00Z') }),
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    await service.onMissionConfirmed('m1');
    await service.onMissionConfirmed('m2');
    const outcome = await service.onMissionConfirmed('m3');

    expect(outcome.counted).toBe(false);
    expect(outcome.reason).toBe('FRAUD_FLAGGED');
    /* Un signalement par mission. */
    expect(w.flags.size).toBe(2);
    /* Le compteur reste à 1 : aucune mission gelée n'a été comptée. */
    expect(prog(w).missionCount).toBe(1);
  });

  it('casse la chaîne dès qu’un autre technicien intervient', async () => {
    /* Sortie réaliste de la zone de fraude : m2 est écartée, m3 est confiée à
     * un autre technicien dans la fenêtre → elle est comptée normalement. */
    const w = world({
      demandes: [
        confirmed({ id: 'm1', technicianId: 't1', updatedAt: new Date('2026-10-09T11:00:00Z') }),
        confirmed({ id: 'm2', technicianId: 't1', updatedAt: new Date('2026-10-10T11:00:00Z') }),
        confirmed({ id: 'm3', technicianId: 't2', updatedAt: new Date('2026-10-10T12:00:00Z') }),
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    await service.onMissionConfirmed('m1');
    await service.onMissionConfirmed('m2');
    const outcome = await service.onMissionConfirmed('m3');

    expect(outcome.counted).toBe(true);
    expect(w.flags.size).toBe(1);
    expect(prog(w).missionCount).toBe(2);
  });

  it('ignore une mission CONFIRMED ancienne comme référence (updatedAt antérieur)', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', technicianId: 't1', updatedAt: new Date('2026-10-01T18:00:00Z') }),
        confirmed({ id: 'm2', technicianId: 't1', updatedAt: new Date('2026-10-01T10:00:00Z') }),
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    /* m1 est « postérieure » à m2 : elle n'est pas la mission PRÉCÉDENTE, donc
     * aucune fraude (le service ne compare qu'à l'antérieure). */
    const outcome = await service.onMissionConfirmed('m2');

    expect(outcome.counted).toBe(true);
    expect(w.flags.size).toBe(0);
  });

  it('ne crée pas de second signalement si la mission en a déjà un (rejeu)', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', updatedAt: new Date('2026-10-01T12:00:00Z') }),
      ],
      flags: [
        {
          id: 'existant',
          userId: 'c1',
          demandeId: 'm2',
          technicianId: 't1',
          reason: 'SAME_TECHNICIAN_48H',
          detectedAt: new Date(),
          resolvedAt: null,
          decision: null,
          note: null,
        },
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const outcome = await service.onMissionConfirmed('m2');

    expect(outcome.counted).toBe(false);
    expect(outcome.flagId).toBe('existant');
    expect(w.flags.size).toBe(1);
  });

  it('absorbe la course entre deux traitements (P2002) sans remonter d’erreur', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', updatedAt: new Date('2026-10-01T12:00:00Z') }),
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const [a, b] = await Promise.all([
      service.onMissionConfirmed('m2'),
      service.onMissionConfirmed('m2'),
    ]);

    expect(a.counted).toBe(false);
    expect(b.counted).toBe(false);
    expect(w.flags.size).toBe(1);
    /* m1 n'a jamais été confirmée dans ce scénario : rien n'est compté. */
    expect(w.progress.size).toBe(0);
  });

  it("ne déclenche PAS l'anti-fraude sur une mission sans technicien", async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', technicianId: null, updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', technicianId: null, updatedAt: new Date('2026-10-01T12:00:00Z') }),
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const outcome = await service.onMissionConfirmed('m2');

    expect(outcome.counted).toBe(true);
    expect(w.flags.size).toBe(0);
  });

  it('ne déclenche PAS l’anti-fraude si la mission ne compte pas (montant trop bas)', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', finalAmount: 1_000, updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', finalAmount: 1_000, updatedAt: new Date('2026-10-01T12:00:00Z') }),
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const outcome = await service.onMissionConfirmed('m2');

    expect(outcome).toEqual({ counted: false, reason: 'AMOUNT_BELOW_MINIMUM' });
    expect(w.flags.size).toBe(0);
  });
});

describe('RewardsService.resolveFraudFlag', () => {
  const flagged = () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', reference: 'RD-AAA111', updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', reference: 'RD-BBB222', updatedAt: new Date('2026-10-01T12:00:00Z') }),
      ],
    });
    w.flags.set('f1', {
      id: 'f1',
      userId: 'c1',
      demandeId: 'm2',
      technicianId: 't1',
      reason: 'SAME_TECHNICIAN_48H',
      detectedAt: new Date('2026-10-01T12:00:01Z'),
      resolvedAt: null,
      resolvedBy: null,
      decision: null,
      note: null,
    });
    return w;
  };

  it('VALIDATED : comptabilise la mission et notifie les paliers', async () => {
    const w = flagged();
    const notifications = notificationsSpy();
    /* Compteur à 14 : la validation de m2 fait franchir BRONZE. */
    w.progress.set('c1', {
      id: 'p1',
      userId: 'c1',
      missionCount: 14,
      currentTier: 'NONE',
      reachedTiers: [],
      claimedTiers: [],
      lastMissionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const service = new RewardsService(w.prisma, notifications);

    const result = await service.resolveFraudFlag('f1', 'VALIDATED', 'admin1', 'Fausse alerte');

    expect(result.counted).toBe(true);
    expect(result.decision).toBe('VALIDATED');
    expect(prog(w).missionCount).toBe(15);
    expect(notifications.notifyTierReached).toHaveBeenCalledTimes(1);
    /* VALIDATED = la mission est normale : aucune notification « écartée ». */
    expect(notifications.notifyMissionNotCounted).not.toHaveBeenCalled();
    expect(flagOf(w)).toEqual(
      expect.objectContaining({
        decision: 'VALIDATED',
        resolvedBy: 'admin1',
        note: 'Fausse alerte',
      }),
    );
    expect(flagOf(w).resolvedAt).toBeInstanceOf(Date);
  });

  it('REJECTED : ne compte PAS la mission et notifie le client', async () => {
    const w = flagged();
    const notifications = notificationsSpy();
    w.progress.set('c1', {
      id: 'p1',
      userId: 'c1',
      missionCount: 1,
      currentTier: 'NONE',
      reachedTiers: [],
      claimedTiers: [],
      lastMissionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const service = new RewardsService(w.prisma, notifications);

    const result = await service.resolveFraudFlag('f1', 'REJECTED', 'admin1');

    expect(result.counted).toBe(false);
    expect(result.decision).toBe('REJECTED');
    /* Le compteur reste à 1 : seule m1 compte. */
    expect(prog(w).missionCount).toBe(1);
    expect(notifications.notifyMissionNotCounted).toHaveBeenCalledWith(
      'c1',
      'SAME_TECHNICIAN_48H',
      'RD-BBB222',
    );
    expect(notifications.notifyTierReached).not.toHaveBeenCalled();
    expect(flagOf(w).decision).toBe('REJECTED');
  });

  it('refuse une décision inconnue', async () => {
    const w = flagged();
    const service = new RewardsService(w.prisma, notificationsSpy());

    await expect(
      service.resolveFraudFlag('f1', 'PEUT_ETRE' as never, 'admin1'),
    ).rejects.toThrow(/Décision invalide/);
    expect(flagOf(w).resolvedAt).toBeNull();
  });

  it('refuse un signalement déjà traité (claim atomique)', async () => {
    const w = flagged();
    flagOf(w).resolvedAt = new Date();
    flagOf(w).decision = 'REJECTED';
    const service = new RewardsService(w.prisma, notificationsSpy());

    await expect(service.resolveFraudFlag('f1', 'VALIDATED', 'admin2')).rejects.toThrow(
      /déjà été traité/,
    );
    /* Surtout : aucune double comptabilisation. */
    expect(w.progress.size).toBe(0);
  });

  it('refuse un signalement inexistant', async () => {
    const w = flagged();
    const service = new RewardsService(w.prisma, notificationsSpy());

    await expect(service.resolveFraudFlag('inconnu', 'VALIDATED', 'admin1')).rejects.toThrow(
      /introuvable/i,
    );
  });
});

describe('RewardsService.listFraudFlags', () => {
  it('liste les dossiers ouverts par défaut et sérialise sans exposer de secret', async () => {
    const w = world({
      demandes: [confirmed({ id: 'm2', reference: 'RD-BBB222', finalAmount: 20_000 })],
      users: {
        c1: { id: 'c1', firstName: 'Awa', lastName: 'N.', email: 'awa@test.cm' },
        t1: { id: 't1', firstName: 'Jean', lastName: 'B.' },
      },
      flags: [
        {
          id: 'f1',
          userId: 'c1',
          demandeId: 'm2',
          technicianId: 't1',
          reason: 'SAME_TECHNICIAN_48H',
          detectedAt: new Date('2026-10-01T12:00:01Z'),
          resolvedAt: null,
          resolvedBy: null,
          decision: null,
          note: null,
        },
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const rows = await service.listFraudFlags({ resolved: false });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'f1',
      reason: 'SAME_TECHNICIAN_48H',
      detectedAt: '2026-10-01T12:00:01.000Z',
      resolvedAt: null,
      decision: null,
      note: null,
      userId: 'c1',
      clientName: 'Awa N.',
      demandeId: 'm2',
      missionReference: 'RD-BBB222',
      missionFinalAmountXAF: 20_000,
      missionStatus: 'CONFIRMED',
      technicianId: 't1',
      technicianName: 'Jean B.',
    });
  });

  it('filtre sur les dossiers résolus', async () => {
    const w = world({
      demandes: [confirmed({ id: 'm2' })],
      flags: [
        {
          id: 'f1',
          userId: 'c1',
          demandeId: 'm2',
          technicianId: 't1',
          reason: 'SAME_TECHNICIAN_48H',
          detectedAt: new Date(),
          resolvedAt: new Date(),
          resolvedBy: 'a1',
          decision: 'VALIDATED',
          note: null,
        },
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    expect(await service.listFraudFlags({ resolved: true })).toHaveLength(1);
    expect(await service.listFraudFlags({ resolved: false })).toHaveLength(0);
    /* Une décision inattendue en base ne fuit pas en clair vers l'API. */
    expect((await service.listFraudFlags({ resolved: true }))[0].decision).toBe('VALIDATED');
  });
});

describe('RewardsService.getProgress', () => {
  it('renvoie un état à zéro pour un client sans aucune mission payée', async () => {
    const w = world();
    const service = new RewardsService(w.prisma, notificationsSpy());

    const progress = await service.getProgress('c1');

    expect(progress.missionCount).toBe(0);
    expect(progress.currentTier).toBe('NONE');
    expect(progress.reachedTiers).toEqual([]);
    expect(progress.claimedTiers).toEqual([]);
    expect(progress.nextTier).toEqual(
      expect.objectContaining({ tier: 'BRONZE', missions: 15, remaining: 15 }),
    );
    expect(progress.tiers).toHaveLength(4);
  });

  it('renvoie le compteur, le niveau et le prochain palier', async () => {
    const w = world({
      progress: [
        {
          id: 'p1',
          userId: 'c1',
          missionCount: 50,
          currentTier: 'ARGENT',
          reachedTiers: ['BRONZE', 'ARGENT'],
          claimedTiers: ['BRONZE'],
          lastMissionAt: new Date('2026-10-01T10:00:00Z'),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const progress = await service.getProgress('c1');

    expect(progress.missionCount).toBe(50);
    expect(progress.currentTier).toBe('ARGENT');
    expect(progress.reachedTiers).toEqual(['BRONZE', 'ARGENT']);
    expect(progress.claimedTiers).toEqual(['BRONZE']);
    expect(progress.lastMissionAt).toBe('2026-10-01T10:00:00.000Z');
    expect(progress.nextTier).toEqual(expect.objectContaining({ tier: 'OR', remaining: 100 }));
  });

  it('renvoie nextTier null une fois tous les paliers franchis (aucun reset)', async () => {
    const w = world({
      progress: [
        {
          id: 'p1',
          userId: 'c1',
          missionCount: 500,
          currentTier: 'PLATINE',
          reachedTiers: ['BRONZE', 'ARGENT', 'OR', 'PLATINE'],
          claimedTiers: [],
          lastMissionAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    expect((await service.getProgress('c1')).nextTier).toBeNull();
  });

  it('expose les 4 paliers avec un montant XAF entier (jamais formaté)', async () => {
    const w = world();
    const service = new RewardsService(w.prisma, notificationsSpy());

    const { tiers } = await service.getProgress('c1');

    for (const tier of tiers) {
      expect(Number.isInteger(tier.rewardValueXAF)).toBe(true);
      expect(tier.reward).not.toMatch(/FCFA/);
    }
  });
});

describe('RewardsService.claimTier', () => {
  const withReached = (reached: string[], claimed: string[] = []) => ({
    progress: [
      {
        id: 'p1',
        userId: 'c1',
        missionCount: 20,
        currentTier: 'BRONZE',
        reachedTiers: reached,
        claimedTiers: claimed,
        lastMissionAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  });

  it('enregistre la demande sur un palier atteint non encore demandé', async () => {
    const w = world(withReached(['BRONZE']));
    const service = new RewardsService(w.prisma, notificationsSpy());

    const result = await service.claimTier('c1', 'BRONZE');

    expect(result.success).toBe(true);
    expect(result.tier).toBe('BRONZE');
    expect(result.claimedTiers).toEqual(['BRONZE']);
    expect(prog(w).claimedTiers).toEqual(['BRONZE']);
  });

  it('refuse un palier NON atteint (400)', async () => {
    const w = world(withReached(['BRONZE']));
    const service = new RewardsService(w.prisma, notificationsSpy());

    await expect(service.claimTier('c1', 'OR')).rejects.toThrow(/pas encore atteint/);
    expect(prog(w).claimedTiers).toEqual([]);
  });

  it('refuse un palier DÉJÀ demandé (400)', async () => {
    const w = world(withReached(['BRONZE'], ['BRONZE']));
    const service = new RewardsService(w.prisma, notificationsSpy());

    await expect(service.claimTier('c1', 'BRONZE')).rejects.toThrow(/déjà été enregistrée/);
    expect(prog(w).claimedTiers).toEqual(['BRONZE']);
  });

  it('refuse un palier inconnu (400)', async () => {
    const w = world(withReached(['BRONZE']));
    const service = new RewardsService(w.prisma, notificationsSpy());

    await expect(service.claimTier('c1', 'DIAMANT')).rejects.toThrow(/Palier inconnu/);
  });

  it('permet de demander deux paliers différents', async () => {
    const w = world(withReached(['BRONZE', 'ARGENT']));
    const service = new RewardsService(w.prisma, notificationsSpy());

    await service.claimTier('c1', 'BRONZE');
    await service.claimTier('c1', 'ARGENT');

    expect(prog(w).claimedTiers).toEqual(['BRONZE', 'ARGENT']);
  });

  it('refuse toute demande pour un client sans progression', async () => {
    const w = world();
    const service = new RewardsService(w.prisma, notificationsSpy());

    await expect(service.claimTier('c1', 'BRONZE')).rejects.toThrow(/pas encore atteint/);
  });
});
