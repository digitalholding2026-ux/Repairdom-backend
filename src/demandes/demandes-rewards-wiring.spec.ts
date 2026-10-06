import { describe, expect, it, vi } from 'vitest';
import { DemandesService } from './demandes.service.js';
import { UpdateDemandeStatusDto } from './dto/update-demande-status.dto.js';
import type { RewardsService } from '../rewards/rewards.service.js';

/* Chantier #4A — CÂBLAGE du comptage des récompenses sur la confirmation.
 *
 * Ce test verrouille le point le plus sensible du chantier : l'appel doit être
 * fait APRÈS la transaction (le règlement financier est acquis), UNIQUEMENT
 * sur CONFIRMED, et son échec ne doit JAMAIS faire échouer la confirmation.
 *
 * On teste donc `updateStatus(..., { status: 'CONFIRMED' })` avec un
 * `RewardsService` double, sur un `$transaction` simulé. */

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

function harness(seed: Row = confirmedDemande()) {
  const store = { demande: { ...seed } };
  const order: string[] = [];

  /* `$transaction` exécute réellement le callback sur un `tx` qui écrit dans
   * `store` : on peut donc vérifier que l'appel récompenses a eu lieu APRÈS
   * l'écriture du statut. */
  const tx = {
    demande: {
      findFirst: async () => store.demande,
      updateMany: async ({ data }: any) => {
        order.push('transaction:status');
        store.demande = { ...store.demande, ...data };
        return { count: 1 };
      },
      findFirstOrThrow: async () => store.demande,
    },
    demandeEvent: { create: async () => ({ id: 'e1' }) },
    notification: { create: async ({ data }: any) => ({ id: 'n1', ...data }) },
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
  } as unknown as RewardsService & { onMissionConfirmed: ReturnType<typeof vi.fn> };

  const service = new DemandesService(
    prisma,
    financial as never,
    { dispatchWave1: vi.fn() } as never,
    { isConfirmationBlocked: vi.fn(async () => false) } as never,
    undefined,
    rewards,
  );

  return { service, rewards, financial, order, store };
}

const CONFIRMED = { status: 'CONFIRMED' } as UpdateDemandeStatusDto;
const CANCELED = { status: 'CANCELED' } as UpdateDemandeStatusDto;

describe('DemandesService.updateStatus — câblage récompenses', () => {
  it('déclenche le comptage sur une confirmation', async () => {
    const h = harness();
    await h.service.updateStatus('c1', 'm1', CONFIRMED);

    expect(h.rewards.onMissionConfirmed).toHaveBeenCalledExactlyOnceWith('m1');
  });

  it('déclenche le comptage APRÈS la transaction ET après le règlement financier', async () => {
    const h = harness();
    await h.service.updateStatus('c1', 'm1', CONFIRMED);

    /* Ordre critique : le règlement est un fait acquis, le compteur ne peut
     * pas précéder le commit. */
    expect(h.order).toEqual([
      'transaction:begin',
      'transaction:status',
      'financial:settle',
      'transaction:commit',
      'rewards:onMissionConfirmed',
    ]);
  });

  it('NE déclenche PAS le comptage sur une annulation', async () => {
    /* `COMPLETED → CANCELED` est interdit par la machine à transitions : on
     * part donc d'une mission SCHEDULED, seul état client-annulable restant. */
    const h = harness(confirmedDemande({ status: 'SCHEDULED' }));
    await h.service.updateStatus('c1', 'm1', CANCELED);

    expect(h.rewards.onMissionConfirmed).not.toHaveBeenCalled();
    expect(h.financial.releaseMissionHoldIfAny).toHaveBeenCalledTimes(1);
    /* Une annulation ne débite rien d'autre et ne compte aucune récompense. */
    expect(h.financial.settleMissionAtConfirmation).not.toHaveBeenCalled();
  });

  it('la mission reste CONFIRMED même si le comptage des récompenses échoue', async () => {
    const h = harness();
    h.rewards.onMissionConfirmed.mockRejectedValue(new Error('ClientRewardProgress indisponible'));

    /* LE point critique du chantier : le règlement est déjà commité, on ne
     * peut pas faire échouer la confirmation à cause d'un compteur. */
    await expect(h.service.updateStatus('c1', 'm1', CONFIRMED)).resolves.toBeDefined();

    expect(h.store.demande.status).toBe('CONFIRMED');
    expect(h.financial.settleMissionAtConfirmation).toHaveBeenCalledTimes(1);
  });

  it('la confirmation reste bloquée par un litige (le câblage n’y touche pas)', async () => {
    const h = harness();
    const disputes = { isConfirmationBlocked: vi.fn(async () => true) };
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
      disputes as never,
      undefined,
      h.rewards,
    );

    await expect(service.updateStatus('c1', 'm1', CONFIRMED)).rejects.toThrow(/litige/i);
    expect(h.rewards.onMissionConfirmed).not.toHaveBeenCalled();
  });

  it('fonctionne sans RewardsService injecté (tests unitaires existants)', async () => {
    /* Les tests historiques de `DemandesService` n'instancient pas
     * `RewardsModule` : l'optional chaining doit rendre le comptage neutre. */
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
});
