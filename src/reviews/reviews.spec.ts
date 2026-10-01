import { describe, expect, it, vi } from 'vitest';
import { ReviewsService } from './reviews.service.js';

/* Correctif post-audit — couverture Reviews (aucune spec auparavant) :
 * création gardée (CONFIRMED + technicien assigné + partie prenante),
 * unicité par auteur, ownership lecture, réputation. Comportement inchangé. */

type Row = Record<string, any>;

const CONFIRMED: Row = {
  id: 'm1',
  status: 'CONFIRMED',
  clientId: 'c1',
  technicianId: 't1',
};

function reviewService(options: {
  demande?: Row | null;
  reviews?: Row[];
  aggregate?: { avg: number | null; count: number };
  missionTech?: boolean;
} = {}) {
  const reviews: Row[] = (options.reviews ?? []).map((r) => ({ ...r }));
  const prisma = {
    demande: {
      findUnique: vi.fn(async () => (options.demande === undefined ? { ...CONFIRMED } : options.demande ? { ...options.demande } : null)),
      findFirst: vi.fn(async () => (options.missionTech ? { id: 'm1' } : null)),
    },
    review: {
      create: vi.fn(async ({ data }: any) => {
        if (reviews.some((r) => r.demandeId === data.demandeId && r.authorId === data.authorId)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        const row = {
          id: `r-${reviews.length + 1}`,
          comment: null,
          createdAt: new Date(),
          author: { id: data.authorId, firstName: 'A', lastName: null },
          target: { id: data.targetId, firstName: 'B', lastName: null },
          ...data,
        };
        reviews.push(row);
        return { ...row };
      }),
      findMany: vi.fn(async () => reviews.map((r) => ({ ...r }))),
      aggregate: vi.fn(async () => ({
        _avg: { rating: options.aggregate?.avg ?? null },
        _count: options.aggregate?.count ?? 0,
      })),
    },
  };
  return { service: new ReviewsService(prisma as never), prisma, reviews };
}

const CLIENT = { id: 'c1', role: 'CLIENT' } as never;
const TECH = { id: 't1', role: 'TECHNICIAN' } as never;
const VALID_DTO = { rating: 5, comment: 'Travail soigné.' } as never;

describe('createReview — gardes métier', () => {
  it('mission CONFIRMED + technicien : client → cible technicien', async () => {
    const { service } = reviewService();
    const result = await service.createReview(CLIENT, 'm1', VALID_DTO);
    expect(result).toMatchObject({ demandeId: 'm1', authorId: 'c1', targetId: 't1', rating: 5 });
  });

  it('technicien → cible client', async () => {
    const { service } = reviewService();
    const result = await service.createReview(TECH, 'm1', { rating: 4 } as never);
    expect(result).toMatchObject({ authorId: 't1', targetId: 'c1' });
  });

  it('mission non confirmée (COMPLETED) → 409', async () => {
    const { service } = reviewService({ demande: { ...CONFIRMED, status: 'COMPLETED' } });
    await expect(service.createReview(CLIENT, 'm1', VALID_DTO)).rejects.toMatchObject({ status: 409 });
  });

  it('sans technicien assigné → 409', async () => {
    const { service } = reviewService({ demande: { ...CONFIRMED, technicianId: null } });
    await expect(service.createReview(CLIENT, 'm1', VALID_DTO)).rejects.toMatchObject({ status: 409 });
  });

  it('étranger à la mission → 403 ; demande inconnue → 404', async () => {
    const { service } = reviewService();
    await expect(
      service.createReview({ id: 'stranger', role: 'CLIENT' } as never, 'm1', VALID_DTO),
    ).rejects.toMatchObject({ status: 403 });
    const missing = reviewService({ demande: null });
    await expect(missing.service.createReview(CLIENT, 'm1', VALID_DTO)).rejects.toMatchObject({ status: 404 });
  });

  it('doublon (même auteur) → 409, jamais deux avis', async () => {
    const { service, reviews } = reviewService();
    await service.createReview(CLIENT, 'm1', VALID_DTO);
    await expect(service.createReview(CLIENT, 'm1', VALID_DTO)).rejects.toMatchObject({ status: 409 });
    expect(reviews).toHaveLength(1);
  });
});

describe('listForDemande — ownership', () => {
  it('étranger → 404 masqué ; partie → liste + mine', async () => {
    const seeded = [
      { id: 'r-1', demandeId: 'm1', authorId: 'c1', targetId: 't1', rating: 5, comment: null, createdAt: new Date(), author: { id: 'c1', firstName: 'A', lastName: null }, target: { id: 't1', firstName: 'B', lastName: null } },
    ];
    const { service } = reviewService({ reviews: seeded });
    await expect(
      service.listForDemande({ id: 'stranger', role: 'CLIENT' } as never, 'm1'),
    ).rejects.toMatchObject({ status: 404 });
    const result = await service.listForDemande(CLIENT, 'm1');
    expect(result.reviews).toHaveLength(1);
    expect(result.mine?.authorId).toBe('c1');
    const techView = await service.listForDemande(TECH, 'm1');
    expect(techView.mine).toBeNull();
  });
});

describe('réputation — accès et calcul', () => {
  it('technicien : moyenne arrondie 1 décimale + total', async () => {
    const { service } = reviewService({ aggregate: { avg: 4.666, count: 3 } });
    expect(await service.getTechnicianReputation(CLIENT, 't1')).toEqual({ averageRating: 4.7, totalReviews: 3 });
  });

  it('sans avis → { null, 0 }', async () => {
    const { service } = reviewService();
    expect(await service.getTechnicianReputation(CLIENT, 't1')).toEqual({ averageRating: null, totalReviews: 0 });
  });

  it('réputation client : propriétaire OK, technicien mission OK, espion → 403', async () => {
    const { service } = reviewService({ aggregate: { avg: 5, count: 1 } });
    expect(await service.getClientReputation(CLIENT, 'c1')).toMatchObject({ totalReviews: 1 });
    const withMission = reviewService({ aggregate: { avg: 5, count: 1 }, missionTech: true });
    expect(await withMission.service.getClientReputation(TECH, 'c1')).toMatchObject({ totalReviews: 1 });
    await expect(service.getClientReputation(TECH, 'c1')).rejects.toMatchObject({ status: 403 });
    await expect(
      service.getClientReputation({ id: 'stranger', role: 'CLIENT' } as never, 'c1'),
    ).rejects.toMatchObject({ status: 403 });
  });
});
