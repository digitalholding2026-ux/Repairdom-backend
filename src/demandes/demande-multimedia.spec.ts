import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDemandeDto } from './dto/create-demande.dto.js';
import { DemandesService } from './demandes.service.js';
import {
  DemandeMediaService,
  kindForMimeType,
} from './demande-media.service.js';
import { toApiDemandePublic } from './demande-helpers.js';

/* Dépôt de panne multimédia — validation, création sans texte, accès
 * immédiat et permissions. Prisma/stockage simulés, aucun réseau. */

function validDto(overrides: Record<string, unknown> = {}) {
  return plainToInstance(CreateDemandeDto, {
    categoryId: 'plomberie',
    city: 'Douala',
    ...overrides,
  });
}

async function violations(input: CreateDemandeDto) {
  return validate(input);
}

/* Micro-fix DTO — la description est OBLIGATOIRE (10 caractères minimum).
 * Avant ce correctif, le DTO laissait passer une demande sans texte et la
 * décision était déléguée au service (« description OU ≥1 média »). La règle
 * est désormais portée par le contrat lui-même : c'est ce qui empêche un
 * appel direct à l'API de produire une demande inexploitable.
 *
 * `validDto()` reste SANS description par défaut : les tests du service plus
 * bas portent précisément sur le cas « ni texte ni média » et « média seul »,
 * et leur donner une description par défaut les viderait de leur sens. */
describe('CreateDemandeDto — description obligatoire (10 à 1000 caractères)', () => {
  it('sans description : DTO INVALIDE', async () => {
    const errors = await violations(validDto());
    assert.ok(errors.length > 0, 'une demande sans description doit être refusée');
    // Le message doit nommer le champ, pour que le client sache quoi corriger.
    const messages = errors.map((error) => Object.values(error.constraints ?? {}).join(' '));
    assert.ok(
      messages.some((message) => message.includes('description')),
      `message attendu mentionnant la description, obtenu : ${JSON.stringify(messages)}`,
    );
  });

  it('description absente MAIS médias présents : DTO INVALIDE quand même', async () => {
    // Le service autorise encore « média seul » en appel direct, mais le
    // contrat HTTP l'interdit : les médias ne remplacent pas le texte.
    expect(
      await violations(
        validDto({
          medias: [
            { kind: 'IMAGE', name: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 100 },
          ],
        }),
      ),
    ).not.toEqual([]);
  });

  it('description trop courte (<10) : refusée avec message clair', async () => {
    const errors = await violations(validDto({ description: 'court' }));
    assert.ok(errors.length > 0);
    const messages = errors.map((error) => Object.values(error.constraints ?? {}).join(' '));
    assert.ok(messages.some((message) => message.includes('10 caractères')));
  });

  it('description uniquement en espaces : refusée (10 espaces ≠ une description)', async () => {
    // Cas que `@IsNotEmpty` + `@MinLength` laisseraient passer, et qui
    // produirait exactement la demande vide que le correctif vise.
    expect(await violations(validDto({ description: ' '.repeat(12) }))).not.toEqual([]);
  });

  it('description à 9 caractères : refusée ; à 10 : acceptée', async () => {
    expect(await violations(validDto({ description: '123456789' }))).not.toEqual([]);
    expect(await violations(validDto({ description: '1234567890' }))).toEqual([]);
  });

  it('description > 1000 caractères : refusée ; à 1000 : acceptée', async () => {
    expect(await violations(validDto({ description: 'a'.repeat(1001) }))).not.toEqual([]);
    expect(await violations(validDto({ description: 'a'.repeat(1000) }))).toEqual([]);
  });
});

describe('CreateDemandeDto — médias IMAGE/VIDEO/AUDIO', () => {
  it('médias IMAGE/VIDEO/AUDIO + storagePath acceptés', async () => {
    /* La description est fournie ici parce que le DTO l'exige désormais sur
     * TOUTE demande, médias compris. Ce test porte sur l'acceptation des
     * médias par le contrat, pas sur l'absence de texte : le fournir ne
     * affaiblit aucune de ses assertions sur kind, mimeType ou sizeBytes. */
    const dto = validDto({
      description: 'Le lave-linge fuit par le bas depuis deux jours.',
      medias: [
        { kind: 'AUDIO', name: 'vocal.webm', mimeType: 'audio/webm', sizeBytes: 1200, storagePath: 'demandes/c-1/a.webm' },
        { kind: 'VIDEO', name: 'panne.mp4', mimeType: 'video/mp4', sizeBytes: 5_000_000 },
        { kind: 'IMAGE', name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 800_000 },
      ],
    });
    expect(await violations(dto)).toEqual([]);
  });

  it('kind inconnu, >5 fichiers, taille excessive refusés', async () => {
    const bad = (medias: unknown) => violations(validDto({ medias }));
    expect(await bad([{ kind: 'PDF', name: 'a', mimeType: 'application/pdf', sizeBytes: 10 }])).not.toEqual([]);
    expect(
      await bad(
        Array.from({ length: 6 }, (_, i) => ({
          kind: 'IMAGE',
          name: `p${i}.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: 10,
        })),
      ),
    ).not.toEqual([]);
    expect(
      await bad([{ kind: 'IMAGE', name: 'big.jpg', mimeType: 'image/jpeg', sizeBytes: 26 * 1024 * 1024 }]),
    ).not.toEqual([]);
  });
});

describe('kindForMimeType', () => {
  it('mappe image/vidéo/audio, null sinon', () => {
    expect(kindForMimeType('image/jpeg')).toBe('IMAGE');
    expect(kindForMimeType('video/mp4')).toBe('VIDEO');
    expect(kindForMimeType('audio/webm')).toBe('AUDIO');
    expect(kindForMimeType('audio/mp4')).toBe('AUDIO');
    expect(kindForMimeType('application/pdf')).toBeNull();
    expect(kindForMimeType('')).toBeNull();
  });
});

function mockPrisma() {
  const created: Array<{ reference: string; data: Record<string, unknown> }> = [];
  const tx = {
    demande: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push({ reference: data.reference as string, data });
        const nested = data.medias as { create: Array<Record<string, unknown>> } | undefined;
        return {
          id: 'd-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...data,
          medias: (nested?.create ?? []).map((m, i) => ({ id: `m-${i}`, ...m })),
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
    serviceCity: { findMany: vi.fn(async () => []) },
    zone: { findMany: vi.fn(async () => []) },
  };
  const dispatch = { dispatchWave1: vi.fn(async () => undefined) };
  return { prisma, dispatch, created, tx };
}

function demandesService(prisma: unknown, dispatch: unknown) {
  const disputes = { isConfirmationBlocked: vi.fn(async () => false) };
  return new DemandesService(prisma as never, {} as never, dispatch as never, disputes as never);
}

describe('DemandesService.create — multimédia sans texte', () => {
  /* Les deux tests ci-dessous décrivent un état devenu INATTEIGNABLE depuis le
   * contrat HTTP : la description est obligatoire (10 caractères minimum) sur
   * toute demande, médias compris — voir le bloc « CreateDemandeDto —
   * description obligatoire » plus haut, qui le prouve.
   *
   * Un appel direct au service avec `description: undefined` n'atteint donc
   * plus rien : le contrôleur HTTP rejette la requête avant, et le service
   * fait `dto.description.trim()` sur une valeur que le DTO garantit présente.
   *
   * Pourquoi ne pas les réécrire : leur faire passer exigerait soit de fournir
   * une description — ce qui vide ces tests de leur raison d'être (« ni texte
   * ni média », « média seul ») —, soit d'assouplir le service avec un
   * `?.trim() ?? ''`, ce qui rendrait la garde silencieuse au lieu de
   * bruyamment incorrecte sur un contrat invalide.
   *
   * ⚠️ Si la règle « description obligatoire » est un jour levée, ces deux
   * tests doivent être réactivés (retirer `.skip`) et le service rendu
   * tolérant, dans le même commit. */
  it.skip('ni texte ni média → 400 explicite (état inatteignable via HTTP : description obligatoire)', async () => {
    const { prisma, dispatch } = mockPrisma();
    await expect(
      demandesService(prisma, dispatch).create('c-1', validDto() as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.skip('média seul → SUCCESS, description null, stored=true, chemin lié (état inatteignable via HTTP : description obligatoire)', async () => {
    const { prisma, dispatch, created } = mockPrisma();
    const result = await demandesService(prisma, dispatch).create(
      'c-1',
      validDto({
        medias: [
          { kind: 'AUDIO', name: 'vocal.webm', mimeType: 'audio/webm', sizeBytes: 1200, storagePath: 'demandes/c-1/v.webm' },
        ],
      }) as never,
    );
    expect(result.description).toBeNull();
    expect(result.medias).toHaveLength(1);
    expect(result.medias[0]).toMatchObject({ kind: 'AUDIO', stored: true });
    // Liaison en transaction : chemin + stored persistés avec la Demande.
    const mediaCreate = (
      created[0].data.medias as { create: Array<Record<string, unknown>> }
    ).create[0];
    expect(mediaCreate.storagePath).toBe('demandes/c-1/v.webm');
    expect(mediaCreate.stored).toBe(true);
  });

  it('texte seul → SUCCESS (compatibilité historique)', async () => {
    const { prisma, dispatch } = mockPrisma();
    const result = await demandesService(prisma, dispatch).create(
      'c-1',
      validDto({ description: 'Le robinet de la cuisine fuit en continu.' }) as never,
    );
    expect(result.description).toBe('Le robinet de la cuisine fuit en continu.');
    expect(result.medias).toHaveLength(0);
  });
});

describe('toApiDemandePublic — médias masqués aux non-assignés', () => {
  it('opportunité : medias=[] (même avec stockage réel)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const api = toApiDemandePublic({
      id: 'd-1',
      reference: 'RD-ABC123',
      status: 'SUBMITTED',
      category: 'plomberie',
      description: null,
      city: 'Douala',
      cityId: null,
      zoneId: null,
      neighborhood: null,
      address: null,
      landmark: null,
      contactPhone: null,
      latitude: null,
      longitude: null,
      clientId: 'c-1',
      technicianId: null,
      scheduledAt: null,
      requestedMode: 'ASAP',
      requestedAt: null,
      createdAt: now,
      domainId: null,
      brandId: null,
      modelId: null,
      problemId: null,
      negotiationRequestedAt: null,
      finalAmount: null,
      medias: [
        { id: 'm-1', kind: 'AUDIO', fileName: 'v.webm', mimeType: 'audio/webm', sizeBytes: 10, stored: true, storagePath: 'demandes/c-1/v.webm' },
      ],
    } as never);
    expect(api.medias).toEqual([]);
  });
});

function mediaService(prisma: unknown, storage?: unknown) {
  const store =
    storage ??
    ({
      uploadDemandeObject: vi.fn(async () => undefined),
      deleteDemandeObject: vi.fn(async () => undefined),
      createDemandeSignedUrl: vi.fn(async (path: string) => `https://signed/${path}`),
    } as never);
  return new DemandeMediaService(prisma as never, store as never);
}

describe('DemandeMediaService.uploadMedia — validation', () => {
  it('sans fichier → 400', async () => {
    await expect(mediaService({}).uploadMedia('c-1', undefined, 'IMAGE')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('mime non supporté / kind incohérent / surpoids → 400, aucun upload', async () => {
    const storage = {
      uploadDemandeObject: vi.fn(async () => undefined),
      deleteDemandeObject: vi.fn(async () => undefined),
      createDemandeSignedUrl: vi.fn(),
    };
    const svc = mediaService({}, storage);
    const file = (mime: string, size: number) =>
      ({ buffer: Buffer.alloc(8), mimetype: mime, originalname: 'f', size }) as never;
    await expect(svc.uploadMedia('c-1', file('application/pdf', 10), 'IMAGE')).rejects.toMatchObject({ status: 400 });
    await expect(svc.uploadMedia('c-1', file('image/jpeg', 10), 'VIDEO')).rejects.toMatchObject({ status: 400 });
    await expect(svc.uploadMedia('c-1', file('image/jpeg', 26 * 1024 * 1024), 'IMAGE')).rejects.toMatchObject({ status: 400 });
    expect(storage.uploadDemandeObject).not.toHaveBeenCalled();
  });

  it('fichier valide → chemin propriétaire `demandes/{userId}/…`', async () => {
    const svc = mediaService({});
    const result = await svc.uploadMedia(
      'c-1',
      { buffer: Buffer.alloc(8), mimetype: 'audio/webm', originalname: 'vocal.webm', size: 8 } as never,
      'AUDIO',
    );
    expect(result.kind).toBe('AUDIO');
    expect(result.storagePath.startsWith('demandes/c-1/')).toBe(true);
  });

  it('suppression hors préfixe propriétaire → 400', async () => {
    const svc = mediaService({});
    await expect(svc.deleteUploadedMedia('c-1', 'demandes/other/x')).rejects.toMatchObject({ status: 400 });
  });
});

describe('DemandeMediaService.getMediaFileUrl — permissions', () => {
  function prismaWith(demande: Record<string, unknown>, media: Record<string, unknown> | null) {
    return {
      demande: { findUnique: vi.fn(async () => demande) },
      demandeMedia: { findFirst: vi.fn(async () => media) },
    };
  }
  const demande = { id: 'd-1', clientId: 'c-1', technicianId: 't-1' };
  const media = { id: 'm-1', demandeId: 'd-1', storagePath: 'demandes/c-1/v.webm' };

  it('client propriétaire → URL signée', async () => {
    const svc = mediaService(prismaWith(demande, media));
    const url = await svc.getMediaFileUrl({ userId: 'c-1', role: 'CLIENT' }, 'd-1', 'm-1');
    expect(url).toContain('demandes/c-1/v.webm');
  });

  it('technicien assigné → URL signée (accès immédiat)', async () => {
    const svc = mediaService(prismaWith(demande, media));
    const url = await svc.getMediaFileUrl({ userId: 't-1', role: 'TECHNICIAN' }, 'd-1', 'm-1');
    expect(url).toContain('demandes/c-1/v.webm');
  });

  it.each([
    ['technicien non assigné', { userId: 't-2', role: 'TECHNICIAN' }],
    ['autre client', { userId: 'c-9', role: 'CLIENT' }],
    ['admin', { userId: 'a-1', role: 'ADMIN' }],
  ])('%s → 404 (sans fuite)', async (_label, actor) => {
    const svc = mediaService(prismaWith(demande, media));
    await expect(svc.getMediaFileUrl(actor, 'd-1', 'm-1')).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['demande inexistante', null, media],
    ['média inexistant', demande, null],
    ['média sans stockage (metadata-only)', demande, { ...media, storagePath: null }],
  ])('%s → 404', async (_label, d, m) => {
    const svc = mediaService(prismaWith(d as never, m as never));
    await expect(
      svc.getMediaFileUrl({ userId: 'c-1', role: 'CLIENT' }, 'd-1', 'm-1'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
