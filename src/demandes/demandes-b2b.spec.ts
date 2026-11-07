import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { CreateDemandeDto } from './dto/create-demande.dto.js';
import { DemandesService } from './demandes.service.js';

/* M1 — prestation réservée aux particuliers : un compte professionnel qui
 * appelle la création avec le service smartphone est refusé côté serveur
 * (403), même si l'interface ne le lui proposait pas. Prisma simulé, aucun
 * réseau ; le type de compte est relu en base, jamais pris du payload. */

function dto(overrides: Record<string, unknown> = {}) {
  return plainToInstance(CreateDemandeDto, {
    categoryId: 'autre',
    description: 'La console ne démarre plus du tout depuis hier soir.',
    city: 'Douala',
    equipmentFamily: 'GAME_CONSOLE',
    medias: [{ kind: 'IMAGE', name: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 100 }],
    ...overrides,
  });
}

function mockPrisma(clientType: 'CLIENT' | 'B2B') {
  const inputs: unknown[] = [];
  const tx = {
    demande: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        inputs.push(data);
        return {
          id: 'd-1',
          reference: 'RD-000001',
          status: 'SUBMITTED',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...data,
          medias: [],
          technician: null,
          domain: null,
          brand: null,
          model: null,
          problem: null,
        };
      }),
    },
    demandeEvent: { create: vi.fn(async (args: unknown) => args) },
  };
  const prisma = {
    $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    user: {
      findUnique: vi.fn(async () => ({ clientType })),
    },
    serviceCity: { findMany: vi.fn(async () => []) },
    zone: { findMany: vi.fn(async () => []) },
    problem: { findUnique: vi.fn(async () => null) },
    equipmentFamily: {
      findUnique: vi.fn(async () => ({ code: 'GAME_CONSOLE', category: 'electromenager', isActive: true })),
    },
  };
  const service = new DemandesService(
    prisma as never,
    {} as never,
    { isConfirmationBlocked: vi.fn(async () => false) } as never,
  );
  return { service, inputs, prisma };
}

describe('DemandesService.create — prestation réservée aux particuliers', () => {
  it('un compte B2B qui demande le service smartphone reçoit 403, rien est persisté', async () => {
    const { service, inputs } = mockPrisma('B2B');
    await expect(
      service.create('c-1', dto({ serviceType: 'SMARTPHONE' }) as never),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Le service Réparation smartphone est réservé aux clients particuliers.',
    });
    expect(inputs).toHaveLength(0);
  });

  it('un compte B2B conserve les autres prestations (système)', async () => {
    const { service, inputs } = mockPrisma('B2B');
    await service.create('c-1', dto({ serviceType: 'SYSTEME' }) as never);
    expect(inputs).toHaveLength(1);
  });

  it('un particulier conserve le service smartphone', async () => {
    const { service, inputs } = mockPrisma('CLIENT');
    await service.create('c-1', dto({ serviceType: 'SMARTPHONE' }) as never);
    expect(inputs).toHaveLength(1);
  });
});