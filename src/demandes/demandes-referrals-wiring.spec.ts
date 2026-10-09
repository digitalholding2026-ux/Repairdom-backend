import { describe, expect, it, vi } from 'vitest';
import { DemandesService } from './demandes.service.js';
import { UpdateDemandeStatusDto } from './dto/update-demande-status.dto.js';
import type { ReferralsService } from '../referrals/referrals.service.js';

/* Chantier 4B — CÂBLAGE du versement de la récompense de parrainage sur la
 * confirmation de mission.
 *
 * Ce qui est verrouillé :
 *  1. le déclencheur est bien `CONFIRMED`, et rien d'autre ;
 *  2. il reçoit le CLIENT de la mission, pas le technicien ;
 *  3. il passe APRÈS les récompenses 4A et APRÈS le règlement financier ;
 *  4. son échec ne fait JAMAIS échouer la confirmation.
 *
 * Point 3 est le plus subtil : les deux écrivent au même ledger. Si le
 * parrainage passait avant, une panne du ledger de parrainage pourrait faire
 * échouer la confirmation d'une mission déjà réglée. */

type Row = Record<string, any>;

function confirmedDemande(overrides: Row = {}): Row {
  return {
    id: 'm1',
    reference: 'RD-ABC123',
    status: 'COMPLETED',
    category: 'plomberie',
    description: 'Fuite',
    city: 'Douala',
    cityId: null,
    zoneId: null,
    neighborhood: null,
    address: null,
    landmark: null,
    contactPhone: null,
    clientId: 'c1',
    technicianId: 't1',
    scheduledAt: null,
    requestedMode: 'ASAP',
    requestedAt: null,
    createdAt: new Date(),
    domainId: null,
    brandId: null,
    modelId: null,
    problemId: null,
    negotiationRequestedAt: null,
    finalAmount: 22_000,
    medias: [],
    technician: null,
    ...overrides,
  };
}

function harness(overrides: Row = {}, referralsImpl?: () => Promise<boolean>) {
  const store = { demande: { ...confirmedDemande(overrides) } };
  const order: string[] = [];

  const tx = {
    demande: {
      findFirst: async () => store.demande,
      updateMany: async ({ data }: Row) => {
        order.push('transaction:status');
        store.demande = { ...store.demande, ...data };
        return { count: 1 };
      },
      findFirstOrThrow: async () => store.demande,
    },
    demandeEvent: { create: async () => ({ id: 'e1' }) },
    notification: { create: async ({ data }: Row) => ({ id: 'n1', ...data }) },
  };

  const prisma = {
    $transaction: async (fn: (t: Row) => Promise<Row>) => {
      order.push('transaction:begin');
      const result = await fn(tx);
      order.push('transaction:commit');
      return result;
    },
  } as never;

  const financial = {
    settleMissionAtConfirmation: vi.fn(async () => {
      order.push('financial:settle');
    }),
    releaseMissionHoldIfAny: vi.fn(),
    reverseClientDebitIfAny: vi.fn(),
  };

  const rewards = {
    onMissionConfirmed: vi.fn(async () => {
      order.push('rewards:onMissionConfirmed');
      return { counted: true };
    }),
  };

  const referrals = {
    onReferredMissionConfirmed: vi.fn(async (clientId: string) => {
      order.push(`referrals:${clientId}`);
      return referralsImpl ? referralsImpl() : true;
    }),
  } as unknown as ReferralsService & {
    onReferredMissionConfirmed: ReturnType<typeof vi.fn>;
  };

  const service = new DemandesService(
    prisma,
    financial as never,
    { dispatchWave1: vi.fn() } as never,
    { isConfirmationBlocked: vi.fn(async () => false) } as never,
    undefined,
    rewards as never,
    referrals,
  );

  return { service, rewards, referrals, financial, order, store };
}

const CONFIRMED = { status: 'CONFIRMED' } as UpdateDemandeStatusDto;

describe('DemandesService.updateStatus — câblage parrainage (chantier 4B)', () => {
  it('déclenche le versement sur une confirmation, pour le CLIENT', async () => {
    const h = harness();
    await h.service.updateStatus('c1', 'm1', CONFIRMED);

    expect(h.referrals.onReferredMissionConfirmed).toHaveBeenCalledExactlyOnceWith('c1');
    /* Jamais le technicien : un compte technicien n'a pas de programme. */
    expect(h.referrals.onReferredMissionConfirmed).not.toHaveBeenCalledWith('t1');
  });

  it('déclenche le versement APRÈS la transaction ET après les récompenses 4A', async () => {
    const h = harness();
    await h.service.updateStatus('c1', 'm1', CONFIRMED);

    /* L'ordre est délibéré : une panne du ledger de parrainage ne doit pas
     * pouvoir faire échouer une confirmation déjà réglée. */
    expect(h.order).toEqual([
      'transaction:begin',
      'transaction:status',
      'financial:settle',
      'transaction:commit',
      'rewards:onMissionConfirmed',
      'referrals:c1',
    ]);
  });

  it('NE déclenche PAS le versement sur une annulation', async () => {
    const h = harness({ status: 'SCHEDULED' });
    await h.service.updateStatus('c1', 'm1', { status: 'CANCELED' } as UpdateDemandeStatusDto);
    expect(h.referrals.onReferredMissionConfirmed).not.toHaveBeenCalled();
  });

  it('NE déclenche PAS le versement sur une transition refusée', async () => {
    /* `ASSIGNED → CONFIRMED` n'existe pas dans la machine à états : la
     * demande est refusée avant toute écriture, donc rien n'est versé. */
    const h = harness({ status: 'ASSIGNED' });
    await expect(h.service.updateStatus('c1', 'm1', CONFIRMED)).rejects.toThrow(
      /Aucune transition/i,
    );
    expect(h.referrals.onReferredMissionConfirmed).not.toHaveBeenCalled();
    expect(h.store.demande.status).toBe('ASSIGNED');
  });

  it('la mission reste CONFIRMED et réglée si le versement de parrainage échoue', async () => {
    /* LE point critique : le ledger de parrainage est une bonté. */
    const h = harness({}, async () => {
      throw new Error('FinancialTransaction indisponible');
    });

    await expect(h.service.updateStatus('c1', 'm1', CONFIRMED)).resolves.toBeDefined();

    expect(h.store.demande.status).toBe('CONFIRMED');
    expect(h.financial.settleMissionAtConfirmation).toHaveBeenCalledTimes(1);
    /* Et surtout : les récompenses 4A, passées avant, ne sont pas annulées. */
    expect(h.rewards.onMissionConfirmed).toHaveBeenCalledTimes(1);
  });

  it('une confirmation bloquée par un litige ne verse rien', async () => {
    const h = harness();
    const service = new DemandesService(
      { $transaction: async (fn: (t: Row) => Promise<Row>) => fn({
        demande: {
          findFirst: async () => h.store.demande,
          updateMany: async () => ({ count: 1 }),
          findFirstOrThrow: async () => h.store.demande,
        },
        demandeEvent: { create: async () => ({ id: 'e1' }) },
        notification: { create: async () => ({ id: 'n1' }) },
      }) } as never,
      { settleMissionAtConfirmation: vi.fn(), releaseMissionHoldIfAny: vi.fn(), reverseClientDebitIfAny: vi.fn() } as never,
      { dispatchWave1: vi.fn() } as never,
      { isConfirmationBlocked: vi.fn(async () => true) } as never,
      undefined,
      undefined,
      h.referrals,
    );

    await expect(service.updateStatus('c1', 'm1', CONFIRMED)).rejects.toThrow(/litige/i);
    expect(h.referrals.onReferredMissionConfirmed).not.toHaveBeenCalled();
  });

  it('fonctionne sans ReferralsService injecté (assemblages partiels)', async () => {
    /* Les tests historiques n'instancient pas `ReferralsModule` : l'optional
     * chaining rend le versement neutre. */
    const h = harness();
    const service = new DemandesService(
      { $transaction: async (fn: (t: Row) => Promise<Row>) => fn({
        demande: {
          findFirst: async () => h.store.demande,
          updateMany: async () => ({ count: 1 }),
          findFirstOrThrow: async () => h.store.demande,
        },
        demandeEvent: { create: async () => ({ id: 'e1' }) },
        notification: { create: async () => ({ id: 'n1' }) },
      }) } as never,
      { settleMissionAtConfirmation: vi.fn(), releaseMissionHoldIfAny: vi.fn(), reverseClientDebitIfAny: vi.fn() } as never,
      { dispatchWave1: vi.fn() } as never,
      { isConfirmationBlocked: vi.fn(async () => false) } as never,
    );

    await expect(service.updateStatus('c1', 'm1', CONFIRMED)).resolves.toBeDefined();
  });

  it('un client SANS parrainage ne bloque pas la confirmation', async () => {
    /* `ReferralsService` renvoie `false` (rien à verser) : ce n'est pas une
     * erreur, et la confirmation doit être identique à tous les autres
     * clients — pas plus lente, pas différente. */
    const h = harness({}, async () => false);
    await h.service.updateStatus('c1', 'm1', CONFIRMED);
    expect(h.store.demande.status).toBe('CONFIRMED');
    expect(h.referrals.onReferredMissionConfirmed).toHaveBeenCalledTimes(1);
  });
});
