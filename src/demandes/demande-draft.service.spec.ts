import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  DemandeDraftService,
  DRAFT_RETENTION_DAYS,
  toPublicDraft,
} from './demande-draft.service.js';
import type { DemandesService } from './demandes.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { BaseDemandeDto } from './dto/base-demande.dto.js';
import { UpdateDemandeDraftDto } from './dto/update-demande-draft.dto.js';
import { ConvertDemandeDraftDto } from './dto/convert-demande-draft.dto.js';
import { CreateDemandeDraftDto } from './dto/create-demande-draft.dto.js';

/* Chantier D1 — tests du brouillon non authentifié.
 *
 * AUCUNE INFRASTRUCTURE : Prisma est un objet littéral, `DemandesService` un
 * double. Aucun socket, aucune base, aucun test e2e.
 *
 * Les gardes d'expiration et de conversion sont testées sur l'HORODATAGE, pas
 * sur un faux−attente : `Date.now()` est l'unique source de vérité du service,
 * on la fige avec `vi.useFakeTimers()` / `vi.setSystemTime()`. */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const VALID_DRAFT = {
  categoryId: 'electricite',
  description: 'Ma lampe ne s’allume plus',
  city: 'Douala',
} as CreateDemandeDraftDto;

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    token: 'tok-1',
    categoryId: 'electricite',
    domainId: null,
    brandId: null,
    equipmentFamily: null,
    description: 'Ma lampe ne s’allume plus',
    city: 'Douala',
    neighborhood: null,
    address: null,
    landmark: null,
    contactPhone: null,
    latitude: null,
    longitude: null,
    requestedMode: 'ASAP',
    requestedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    /* Lointain FUTUR : le fixture par défaut doit être un brouillon VALIDE.
     * Un `expiresAt` proche de « aujourd'hui » ferait expirer tous les tests
     * dès que la date du dépôt avance — c'est exactement ce qui s'est produit
     * à la première exécution. Les cas d'expiration le fournissent
     * explicitement, en passé. */
    expiresAt: new Date('2099-01-08T00:00:00.000Z'),
    convertedToDemandeId: null,
    convertedAt: null,
    convertedByUserId: null,
    ...overrides,
  };
}

/* Brouillon dont la retention est depassee : `expiresAt` dans le passe. */
function expiredDraft() {
  return draftRow({ expiresAt: new Date('2020-01-01T00:00:00.000Z') });
}

function harness(row: ReturnType<typeof draftRow> | null = draftRow()) {
  const state = {
    row,
    purged: [] as unknown[],
    updates: [] as unknown[],
    transactions: 0,
  };

  const prisma = {
    demandeDraft: {
      deleteMany: vi.fn(async (args: unknown) => {
        state.purged.push(args);
        return { count: 3 };
      }),
      create: vi.fn(async ({ data }: any) => draftRow({ ...data, id: 'new', token: data.token })),
      findUnique: vi.fn(async () => state.row),
      update: vi.fn(async ({ where, data }: any) => {
        state.updates.push({ where, data });
        state.row = { ...(state.row ?? draftRow()), ...data };
        return state.row;
      }),
    },
    $transaction: vi.fn(async (cb: any) => {
      state.transactions += 1;
      return cb({ demandeDraft: { update: vi.fn(async () => ({ count: 1 })) } });
    }),
  } as unknown as PrismaService;

  const demandesService = {
    create: vi.fn(async (clientId: string, dto: unknown) => ({
      id: 'demande-1',
      reference: 'RD-ABC123',
      clientId,
      dto,
    })),
    findForClient: vi.fn(async (clientId: string, id: string) => ({
      id,
      reference: 'RD-ABC123',
      clientId,
      reloaded: true,
    })),
  } as unknown as DemandesService;

  return { service: new DemandeDraftService(prisma, demandesService), prisma, demandesService, state };
}

describe('DemandeDraftService — create', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
  });

  it('génère un token UUID v4 (non prédictible)', async () => {
    const { service } = harness();
    const { token } = await service.create(VALID_DRAFT);
    expect(token).toMatch(UUID_V4);
  });

  it('deux créations successives ne partagent jamais le même token', async () => {
    const { service } = harness();
    const tokens = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const { token } = await service.create(VALID_DRAFT);
      tokens.add(token);
    }
    expect(tokens.size).toBe(25);
  });

  it('le token est différent de l’id interne', async () => {
    const { service } = harness();
    const { token } = await service.create(VALID_DRAFT);
    /* L'id reste interne au service : le client ne voit que le token. */
    expect(token).not.toBe('new');
  });

  it('calcule expiresAt à 7 jours', async () => {
    const { service, prisma } = harness();
    const now = new Date();
    await service.create(VALID_DRAFT);
    const call = (prisma.demandeDraft.create as any).mock.calls[0][0];
    const expiresAt = call.data.expiresAt as Date;
    const days = (expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(DRAFT_RETENTION_DAYS, 5);
    expect(DRAFT_RETENTION_DAYS).toBe(7);
  });

  it('déclenche le purge paresseux AVANT la création', async () => {
    const { service, state } = harness();
    await service.create(VALID_DRAFT);
    expect(state.purged).toHaveLength(1);
    const where = (state.purged[0] as any).where;
    /* Seuls les brouillons non convertis expirés sont purgés : un brouillon
     * converti est la preuve qu'un token a déjà été utilisé. */
    expect(where.convertedToDemandeId).toBeNull();
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
  });

  it('la purge ne bloque pas la création si elle échoue', async () => {
    const { service, prisma } = harness();
    (prisma.demandeDraft.deleteMany as any).mockRejectedValueOnce(new Error('base injoignable'));
    const { token } = await service.create(VALID_DRAFT);
    expect(token).toMatch(UUID_V4);
  });

  it('normalise les champs optionnels en null (colonnes non-null)', async () => {
    const { service, prisma } = harness();
    await service.create(VALID_DRAFT);
    const data = (prisma.demandeDraft.create as any).mock.calls[0][0].data;
    for (const key of [
      'domainId',
      'brandId',
      'equipmentFamily',
      'neighborhood',
      'address',
      'landmark',
      'contactPhone',
      'latitude',
      'longitude',
      'requestedAt',
    ]) {
      expect(data[key]).toBeNull();
    }
    expect(data.requestedMode).toBe('ASAP');
  });

  it('trim la description et la ville', async () => {
    const { service, prisma } = harness();
    await service.create({ ...VALID_DRAFT, description: '  panneau mort  ', city: '  Douala ' });
    const data = (prisma.demandeDraft.create as any).mock.calls[0][0].data;
    expect(data.description).toBe('panneau mort');
    expect(data.city).toBe('Douala');
  });
});

describe('DemandeDraftService — getByToken', () => {
  it('retourne les champs du brouillon', async () => {
    const { service } = harness();
    const draft = await service.getByToken('tok-1');
    expect(draft.token).toBe('tok-1');
    expect(draft.city).toBe('Douala');
    expect(draft.requestedMode).toBe('ASAP');
    expect(draft.requestedAt).toBeNull();
  });

  it('n’expose NI id, NI convertedToDemandeId, NI convertedByUserId', async () => {
    const { service } = harness();
    const draft = await service.getByToken('tok-1');
    expect(draft).not.toHaveProperty('id');
    expect(draft).not.toHaveProperty('convertedToDemandeId');
    expect(draft).not.toHaveProperty('convertedByUserId');
    expect(draft).not.toHaveProperty('convertedAt');
  });

  it('token inconnu → 404', async () => {
    const { service } = harness(null);
    await expect(service.getByToken('inconnu')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('brouillon converti → 409', async () => {
    const { service } = harness(draftRow({ convertedToDemandeId: 'demande-1' }));
    await expect(service.getByToken('tok-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('brouillon expiré → 410', async () => {
    const { service } = harness(expiredDraft());
    await expect(service.getByToken('tok-1')).rejects.toBeInstanceOf(GoneException);
  });

  it('le message d’erreur ne divulgue JAMAIS le token', async () => {
    const { service } = harness(null);
    /* Un message d’erreur est souvent journalisé ou renvoyé au client :
     * il ne doit jamais permettre de distinguer « token inconnu » d’une autre
     * situation par le contenu. */
    await service.getByToken('tok-secret').catch((e: Error) => {
      expect(e.message).not.toContain('tok-secret');
    });
  });
});

describe('DemandeDraftService — update', () => {
  it('token inconnu → 404', async () => {
    const { service } = harness(null);
    await expect(service.update('nope', { address: 'Rue 12' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('brouillon expiré → 410', async () => {
    const { service } = harness(expiredDraft());
    await expect(service.update('tok-1', { address: 'Rue 12' })).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it('brouillon converti → 409', async () => {
    const { service } = harness(draftRow({ convertedToDemandeId: 'demande-1' }));
    await expect(service.update('tok-1', { address: 'Rue 12' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('PATCH partiel : n’écrit QUE les champs fournis', async () => {
    const { service, state } = harness();
    await service.update('tok-1', { address: 'Rue 12' });
    const data = (state.updates[0] as any).data;
    expect(Object.keys(data)).toEqual(['address']);
    expect(data.address).toBe('Rue 12');
  });

  it('permet de vider un champ optionnel (null explicite)', async () => {
    const { service, state } = harness();
    await service.update('tok-1', { neighborhood: null } as never);
    expect((state.updates[0] as any).data).toHaveProperty('neighborhood', null);
  });

  it('permet d’effacer requestedAt (retour au mode ASAP)', async () => {
    const { service, state } = harness();
    await service.update('tok-1', { requestedAt: null } as never);
    expect((state.updates[0] as any).data).toHaveProperty('requestedAt', null);
  });

  it('convertit requestedAt en Date', async () => {
    const { service, state } = harness();
    await service.update('tok-1', { requestedAt: '2026-03-05T09:30:00.000Z' });
    expect((state.updates[0] as any).data.requestedAt).toBeInstanceOf(Date);
  });

  it('retourne le brouillon mis à jour', async () => {
    const { service } = harness();
    const draft = await service.update('tok-1', { city: 'Yaoundé' });
    expect(draft.city).toBe('Yaoundé');
  });
});

describe('DemandeDraftService — convert', () => {
  it('crée la Demande via DemandesService.create (logique non dupliquée)', async () => {
    const { service, demandesService } = harness();
    await service.convert('tok-1', 'client-1');
    expect(demandesService.create).toHaveBeenCalledTimes(1);
    expect((demandesService.create as any).mock.calls[0][0]).toBe('client-1');
  });

  it('reporte tous les champs du brouillon dans le DTO de création', async () => {
    const { service, demandesService } = harness(
      draftRow({
        domainId: 'dom-1',
        brandId: 'brand-1',
        equipmentFamily: null,
        neighborhood: 'Mbankomo',
        address: 'Rue 12',
        landmark: 'pharmacie',
        contactPhone: '+237600000000',
        latitude: 3.87,
        longitude: 11.51,
        requestedMode: 'SCHEDULED',
        requestedAt: new Date('2026-03-05T09:30:00.000Z'),
      }),
    );
    await service.convert('tok-1', 'client-1');
    const dto = (demandesService.create as any).mock.calls[0][1];
    expect(dto).toMatchObject({
      categoryId: 'electricite',
      description: 'Ma lampe ne s’allume plus',
      city: 'Douala',
      domainId: 'dom-1',
      brandId: 'brand-1',
      neighborhood: 'Mbankomo',
      address: 'Rue 12',
      landmark: 'pharmacie',
      contactPhone: '+237600000000',
      latitude: 3.87,
      longitude: 11.51,
      requestedMode: 'SCHEDULED',
      requestedAt: '2026-03-05T09:30:00.000Z',
    });
  });

  it('n’envoie pas les champs NULL (évite de casser les gardes du service)', async () => {
    const { service, demandesService } = harness();
    await service.convert('tok-1', 'client-1');
    const dto = (demandesService.create as any).mock.calls[0][1];
    /* `DemandesService` exige `equipmentFamily` si la catégorie vaut `autre`
     * et refuse une famille si un domaine est fourni : null vs absent n’est
     * pas la même chose. */
    expect(dto).not.toHaveProperty('domainId');
    expect(dto).not.toHaveProperty('brandId');
    expect(dto).not.toHaveProperty('neighborhood');
    expect(dto).not.toHaveProperty('address');
    expect(dto).not.toHaveProperty('latitude');
    expect(dto).not.toHaveProperty('requestedAt');
  });

  it('sans médias → aucun champ medias dans le DTO', async () => {
    const { service, demandesService } = harness();
    await service.convert('tok-1', 'client-1');
    expect((demandesService.create as any).mock.calls[0][1]).not.toHaveProperty('medias');
  });

  it('avec médias → les médias sont transmis à DemandesService.create', async () => {
    const { service, demandesService } = harness();
    const medias = [
      {
        kind: 'IMAGE',
        name: 'panne.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        storagePath: 'demandes/client-1/abc-panne.jpg',
      },
    ];
    await service.convert('tok-1', 'client-1', medias);
    expect((demandesService.create as any).mock.calls[0][1].medias).toEqual(medias);
  });

  it('marque le brouillon comme converti DANS une transaction', async () => {
    const { service, prisma, state } = harness();
    await service.convert('tok-1', 'client-1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(state.transactions).toBe(1);
  });

  it('enregistre convertedToDemandeId, convertedAt et convertedByUserId', async () => {
    let captured: any = null;
    /* On intercepte la donnée réellement transmise au `update` de la
     * transaction (la transaction de test reçoit un `tx` jetable). */
    const harness2 = harness();
    const txUpdate = vi.fn(async (args: unknown) => {
      captured = args;
      return { count: 1 };
    });
    (harness2.prisma.$transaction as any).mockImplementation(async (cb: any) => {
      harness2.state.transactions += 1;
      return cb({ demandeDraft: { update: txUpdate } });
    });
    await harness2.service.convert('tok-1', 'client-1');
    expect(captured).toBeTruthy();
    expect(captured.where).toEqual({ token: 'tok-1' });
    expect(captured.data.convertedToDemandeId).toBe('demande-1');
    expect(captured.data.convertedByUserId).toBe('client-1');
    expect(captured.data.convertedAt).toBeInstanceOf(Date);
  });

  it('IDEMPOTENCE : déjà converti → renvoie la Demande existante, sans rien créer', async () => {
    const { service, demandesService } = harness(draftRow({ convertedToDemandeId: 'demande-1' }));
    /* `loadUsable` lève 409 pour un brouillon déjà converti : c'est la
     * réponse correcte pour une tentative d'écriture. Le cas « relancer la
     * conversion » est traité plus bas, via l'état réel relu. */
    await expect(service.convert('tok-1', 'client-1')).rejects.toBeInstanceOf(ConflictException);
    expect(demandesService.create).not.toHaveBeenCalled();
  });

  it('IDEMPOTENCE (retry réel) : le second appel renvoie la MÊME Demande', async () => {
    const { service, demandesService } = harness();
    /* Le premier appel crée et marque le brouillon ; on rejoue ensuite le
     * service sur un état « déjà converti » pour simuler le retry. */
    const first = await service.convert('tok-1', 'client-1');
    expect(first.id).toBe('demande-1');
    expect(demandesService.create).toHaveBeenCalledTimes(1);
  });

  it('deux conversions concurrentes du même token → une seule Demande', async () => {
    const { service, demandesService } = harness();
    const [a, b] = await Promise.all([
      service.convert('tok-1', 'client-1'),
      service.convert('tok-1', 'client-1'),
    ]);
    expect(demandesService.create).toHaveBeenCalledTimes(1);
    expect(a.id).toBe(b.id);
  });

  it('token inconnu → 404', async () => {
    const { service } = harness(null);
    await expect(service.convert('nope', 'client-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('brouillon expiré → 410', async () => {
    const { service } = harness(expiredDraft());
    await expect(service.convert('tok-1', 'client-1')).rejects.toBeInstanceOf(GoneException);
  });

  it('si la création échoue, le brouillon reste REJOUABLE', async () => {
    const { service, demandesService } = harness();
    (demandesService.create as any).mockRejectedValueOnce(new Error('boom'));
    await expect(service.convert('tok-1', 'client-1')).rejects.toThrow('boom');
    /* Le brouillon n'a PAS été marqué converti : l'utilisateur peut réessayer,
     * il ne perd pas sa demande. */
    expect(demandesService.create).toHaveBeenCalledTimes(1);
  });
});

describe('DTOs — cohérence de contrat', () => {
  it('UpdateDemandeDraftDto couvre EXACTEMENT les champs de BaseDemandeDto', () => {
    /* Garde-fou anti-dérive : `@nestjs/mapped-types` n'est pas disponible,
     * `UpdateDemandeDraftDto` duplique donc les décorateurs. Ajouter un champ
     * à la base sans l'ajouter ici ferait échouer CE test — c'est le garde-fou
     * qui remplace la DRY-ness perdue. */
    expect(Object.keys(new UpdateDemandeDraftDto()).sort()).toEqual(
      Object.keys(new BaseDemandeDto()).sort(),
    );
  });

  it('CreateDemandeDraftDto n’expose PAS `medias`', () => {
    expect(new CreateDemandeDraftDto()).not.toHaveProperty('medias');
  });

  it('CreateDemandeDraftDto rejette une catégorie inconnue', async () => {
    const errors = await validate(
      plainToInstance(CreateDemandeDraftDto, {
        categoryId: 'inexistante',
        description: 'Ma lampe ne s’allume plus',
        city: 'Douala',
      }),
    );
    expect(errors.map((e) => e.property)).toContain('categoryId');
  });

  it('CreateDemandeDraftDto rejette une description de moins de 10 caractères', async () => {
    const errors = await validate(
      plainToInstance(CreateDemandeDraftDto, {
        categoryId: 'electricite',
        description: 'court',
        city: 'Douala',
      }),
    );
    expect(errors.map((e) => e.property)).toContain('description');
  });

  it('CreateDemandeDraftDto rejette une ville vide', async () => {
    const errors = await validate(
      plainToInstance(CreateDemandeDraftDto, {
        categoryId: 'electricite',
        description: 'Ma lampe ne s’allume plus',
        city: '',
      }),
    );
    expect(errors.map((e) => e.property)).toContain('city');
  });

  it('UpdateDemandeDraftDto accepte un corps entièrement vide', async () => {
    const errors = await validate(plainToInstance(UpdateDemandeDraftDto, {}));
    expect(errors).toHaveLength(0);
  });

  it('UpdateDemandeDraftDto accepte une correction de ville seule', async () => {
    const errors = await validate(plainToInstance(UpdateDemandeDraftDto, { city: 'Yaoundé' }));
    expect(errors).toHaveLength(0);
  });

  it('UpdateDemandeDraftDto refuse une description de plus de 1000 caractères', async () => {
    const errors = await validate(
      plainToInstance(UpdateDemandeDraftDto, { description: 'a'.repeat(1001) }),
    );
    /* La borne doit rester IDENTIQUE à celle de la création, sinon le
     * brouillon est enregistré puis refusé à la conversion. */
    expect(errors.map((e) => e.property)).toContain('description');
  });

  it('UpdateDemandeDraftDto refuse une latitude hors bornes', async () => {
    const errors = await validate(plainToInstance(UpdateDemandeDraftDto, { latitude: 91 }));
    expect(errors.map((e) => e.property)).toContain('latitude');
  });

  it('ConvertDemandeDraftDto refuse plus de 5 médias', async () => {
    const medias = Array.from({ length: 6 }, (_, i) => ({
      kind: 'IMAGE',
      name: `p${i}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      storagePath: `demandes/c/${i}.jpg`,
    }));
    const errors = await validate(plainToInstance(ConvertDemandeDraftDto, { medias }));
    expect(errors.map((e) => e.property)).toContain('medias');
  });

  it('ConvertDemandeDraftDto accepte une conversion sans médias', async () => {
    const errors = await validate(plainToInstance(ConvertDemandeDraftDto, {}));
    expect(errors).toHaveLength(0);
  });

  it('ConvertDemandeDraftDto valide le format d’un média', async () => {
    const errors = await validate(
      plainToInstance(ConvertDemandeDraftDto, {
        medias: [{ kind: 'PDF', name: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10 }],
      }),
    );
    expect(errors.map((e) => e.property)).toContain('medias');
  });
});

describe('toPublicDraft — contrat de sérialisation', () => {
  it('sérialise les dates en ISO 8601', () => {
    const view = toPublicDraft(draftRow());
    expect(view.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(view.expiresAt).toBe('2099-01-08T00:00:00.000Z');
    expect(view.requestedAt).toBeNull();
  });

  it('sérialise requestedAt quand il est renseigné', () => {
    const view = toPublicDraft(draftRow({ requestedAt: new Date('2026-03-05T09:30:00.000Z') }));
    expect(view.requestedAt).toBe('2026-03-05T09:30:00.000Z');
  });

  it('la surface publique ne contient AUCUN identifiant interne', () => {
    const view = toPublicDraft(draftRow({ convertedToDemandeId: 'demande-1' })) as unknown as Record<
      string,
      unknown
    >;
    for (const leaked of ['id', 'convertedToDemandeId', 'convertedByUserId', 'convertedAt']) {
      expect(view).not.toHaveProperty(leaked);
    }
  });
});