import { describe, expect, it, vi } from 'vitest';
import { CollaborationService } from './collaboration.service.js';
import { DemandeMediaService } from '../demandes/demande-media.service.js';

/* IA-3 — diagnostic libre du technicien (Prisma/stockage mockés) : audio
 * lié en transaction, source MANUAL préservée, permissions, texte source
 * intact. Aucun appel IA. */

function collaboration(prisma: unknown) {
  return new CollaborationService(prisma as never, {} as never);
}

function demandeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd-1',
    status: 'ACCEPTED',
    clientId: 'c-1',
    technicianId: 't-1',
    negotiationRequestedAt: null,
    ...overrides,
  };
}

describe('createDiagnostic — audio facultatif lié', () => {
  it('audioStoragePath du technicien → stocké, hasAudio=true', async () => {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      demande: { findUnique: vi.fn(async () => demandeRow()) },
      diagnostic: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: 'dg-1', createdAt: new Date(), technician: { id: 't-1', firstName: 'A', lastName: null }, ...data };
        }),
      },
    };
    const result = await collaboration(prisma).createDiagnostic(
      { id: 't-1', role: 'TECHNICIAN' } as never,
      'd-1',
      { content: 'Carte mère hors service, remplacement nécessaire.', audioStoragePath: 'diagnostics/t-1/note.webm' } as never,
    );
    expect(created[0].audioStoragePath).toBe('diagnostics/t-1/note.webm');
    expect(result.hasAudio).toBe(true);
    expect(result.mode).toBe('MANUAL');
  });

  it("chemin d'un tiers → 400, rien créé", async () => {
    const prisma = {
      demande: { findUnique: vi.fn(async () => demandeRow()) },
      diagnostic: { create: vi.fn() },
    };
    await expect(
      collaboration(prisma).createDiagnostic(
        { id: 't-1', role: 'TECHNICIAN' } as never,
        'd-1',
        { content: 'Panne décrite en détail ici.', audioStoragePath: 'diagnostics/t-9/pirate.webm' } as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.diagnostic.create).not.toHaveBeenCalled();
  });

  it('sans audio → hasAudio=false (compatibilité)', async () => {
    const prisma = {
      demande: { findUnique: vi.fn(async () => demandeRow()) },
      diagnostic: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'dg-1', createdAt: new Date(), technician: { id: 't-1', firstName: 'A', lastName: null }, ...data,
        })),
      },
    };
    const result = await collaboration(prisma).createDiagnostic(
      { id: 't-1', role: 'TECHNICIAN' } as never,
      'd-1',
      { content: 'Panne décrite en détail ici.' } as never,
    );
    expect(result.hasAudio).toBe(false);
  });

  it('client → 403 (ne peut pas modifier le diagnostic technicien)', async () => {
    const prisma = { demande: { findUnique: vi.fn(async () => demandeRow()) } };
    await expect(
      collaboration(prisma).createDiagnostic(
        { id: 'c-1', role: 'CLIENT' } as never,
        'd-1',
        { content: 'Tentative client non autorisée ici.' } as never,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('select MANUAL — texte source intact, audio lié, sans catalogue', () => {
  function selectPrisma() {
    const diagnostics: Array<Record<string, unknown>> = [];
    const tx = {
      quote: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => null),
      },
      diagnostic: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          diagnostics.push(data);
          return { id: 'dg-9', createdAt: new Date(), technician: { id: 't-1', firstName: 'A', lastName: null }, ...data };
        }),
      },
      demandeEvent: { create: vi.fn(async (args: unknown) => args) },
    };
    return {
      diagnostics,
      demande: { findUnique: vi.fn(async () => ({ ...demandeRow(), domainId: null, brandId: null, modelId: null })) },
      technicianProfile: { findUnique: vi.fn(async () => ({ kycStatus: 'VERIFIED' })) },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };
  }

  it('diagnostic libre + audio, catalogDiagnosticId null, texte non écrasé', async () => {
    const prisma = selectPrisma();
    const result = await collaboration(prisma).selectCatalogDiagnostic(
      { id: 't-1', role: 'TECHNICIAN' } as never,
      'd-1',
      {
        mode: 'MANUAL',
        content: 'Compresseur HS, remplacement complet requis.',
        audioStoragePath: 'diagnostics/t-1/n.webm',
      } as never,
    );
    expect(result.mode).toBe('MANUAL');
    expect(result.quote).toBeNull();
    const stored = prisma.diagnostics[0];
    expect(stored.content).toBe('Compresseur HS, remplacement complet requis.');
    expect(stored.catalogDiagnosticId).toBeNull();
    expect(stored.catalogInterventionId).toBeNull();
    expect(stored.audioStoragePath).toBe('diagnostics/t-1/n.webm');
    expect(result.diagnostic.hasAudio).toBe(true);
  });

  it('contenu <10 caractères → 400', async () => {
    const prisma = selectPrisma();
    await expect(
      collaboration(prisma).selectCatalogDiagnostic(
        { id: 't-1', role: 'TECHNICIAN' } as never,
        'd-1',
        { mode: 'MANUAL', content: 'court' } as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('audio du diagnostic — upload et accès', () => {
  function mediaSvc(prisma: unknown, storage?: unknown) {
    const store =
      storage ??
      ({
        uploadDemandeObject: vi.fn(async () => undefined),
        deleteDemandeObject: vi.fn(async () => undefined),
        createDemandeSignedUrl: vi.fn(async (path: string) => `https://signed/${path}`),
      } as never);
    return new DemandeMediaService(prisma as never, store as never);
  }

  it('upload non-audio → 400 ; surpoids → 400', async () => {
    const svc = mediaSvc({});
    const file = (mime: string, size: number) =>
      ({ buffer: Buffer.alloc(8), mimetype: mime, originalname: 'f', size }) as never;
    await expect(svc.uploadDiagnosticAudio('t-1', file('image/jpeg', 10))).rejects.toMatchObject({ status: 400 });
    await expect(svc.uploadDiagnosticAudio('t-1', file('audio/webm', 26 * 1024 * 1024))).rejects.toMatchObject({ status: 400 });
  });

  it('upload valide → préfixe diagnostics/{userId}/', async () => {
    const svc = mediaSvc({});
    const result = await svc.uploadDiagnosticAudio(
      't-1',
      { buffer: Buffer.alloc(8), mimetype: 'audio/webm', originalname: 'note', size: 8 } as never,
    );
    expect(result.kind).toBe('AUDIO');
    expect(result.storagePath.startsWith('diagnostics/t-1/')).toBe(true);
  });

  it('lecture : assigné et propriétaire OK, autres → 404', async () => {
    const demande = { id: 'd-1', clientId: 'c-1', technicianId: 't-1' };
    const diagnostic = { id: 'dg-1', audioStoragePath: 'diagnostics/t-1/n.webm' };
    const prisma = {
      demande: { findUnique: vi.fn(async () => demande) },
      diagnostic: { findFirst: vi.fn(async () => diagnostic) },
    };
    const svc = mediaSvc(prisma);
    expect(await svc.getDiagnosticAudioUrl({ userId: 't-1', role: 'TECHNICIAN' }, 'd-1', 'dg-1')).toContain('diagnostics/t-1/n.webm');
    expect(await svc.getDiagnosticAudioUrl({ userId: 'c-1', role: 'CLIENT' }, 'd-1', 'dg-1')).toContain('diagnostics/t-1/n.webm');
    await expect(
      svc.getDiagnosticAudioUrl({ userId: 't-2', role: 'TECHNICIAN' }, 'd-1', 'dg-1'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('diagnostic sans audio → 404', async () => {
    const prisma = {
      demande: { findUnique: vi.fn(async () => ({ id: 'd-1', clientId: 'c-1', technicianId: 't-1' })) },
      diagnostic: { findFirst: vi.fn(async () => ({ id: 'dg-1', audioStoragePath: null })) },
    };
    await expect(
      mediaSvc(prisma).getDiagnosticAudioUrl({ userId: 't-1', role: 'TECHNICIAN' }, 'd-1', 'dg-1'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
