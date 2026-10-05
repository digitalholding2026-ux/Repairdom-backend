import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TechnicianService } from './technician.service.js';

/* §16 / §26 — sécurité et intégrité du parcours KYC.
 *
 * Ces tests verrouillent les règles qu'un contournement rendrait silencieuses :
 * dépôt en archive, dépôt après validation, faces incompatibles avec la pièce
 * déclarée, effusion de `storagePath` dans une réponse. */

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** PNG 1x1 minimal (signature valide) : le contrôle magic-byte doit passer. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** Ligne `KycDocument` complète : `submitKyc` relit la liste pour la réponse. */
function kycRow(side: 'RECTO' | 'VERSO' | 'SINGLE') {
  return {
    id: `doc-${side}`,
    technicianId: 'tech-1',
    type: 'IDENTITY',
    side,
    mimeType: 'image/png',
    originalName: `carte-${side.toLowerCase()}.png`,
    storagePath: `technicians/tech-1/kyc/${side}.png`,
    size: 1024,
    createdAt: d('2025-01-01'),
  };
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    userId: 'tech-1',
    city: 'Douala',
    cityId: 'city-a',
    categories: ['plomberie'],
    isAvailable: false,
    avatarUrl: null,
    bio: null,
    experience: null,
    serviceDescription: null,
    specialties: [],
    kycStatus: 'NOT_SUBMITTED',
    kycRejectionReason: null,
    activityType: null,
    experienceYears: null,
    familyCodes: [],
    birthDate: null,
    nationality: null,
    kycIdentityDocType: null,
    lastLatitude: null,
    lastLongitude: null,
    locationUpdatedAt: null,
    createdAt: d('2024-01-01'),
    user: {
      firstName: 'Jean',
      lastName: 'Dupont',
      phone: '+237600000000',
      whatsapp: '+237600000000',
      email: 'j@example.com',
      role: 'TECHNICIAN',
    },
    ...overrides,
  };
}

function makeHarness() {
  const uploaded: string[] = [];
  const deleted: string[] = [];

  const prisma = {
    technicianProfile: {
      findUnique: vi.fn().mockResolvedValue(profileRow()),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(profileRow({ ...data })),
      ),
    },
    kycDocument: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockImplementation(({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({ id: 'doc-1', ...create }),
      ),
      delete: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(1),
    },
  };

  const storage = {
    isConfigured: true,
    uploadKycObject: vi.fn().mockImplementation((path: string) => {
      uploaded.push(path);
      return Promise.resolve();
    }),
    deleteKycObject: vi.fn().mockImplementation((path: string) => {
      deleted.push(path);
      return Promise.resolve();
    }),
    createSignedUrl: vi.fn().mockResolvedValue('https://signed.example/doc'),
  };

  const service = new TechnicianService(prisma as never, storage as never, {} as never);
  return { service, prisma, storage, uploaded, deleted };
}

const validFile = (overrides: Partial<{ mimetype: string; size: number; buffer: Buffer }> = {}) => ({
  originalname: 'carte.png',
  mimetype: overrides.mimetype ?? 'image/png',
  size: overrides.size ?? PNG_BYTES.length,
  buffer: overrides.buffer ?? PNG_BYTES,
});

/* ── Contrôle du contenu réel du fichier (§16) ─────────────────────────── */

describe('submitKycDocument — contrôle du fichier', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('archive renommé en .png → refusé (signature魔 absente)', async () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(
      h.service.submitKycDocument('tech-1', validFile({ buffer: zip }) as never, 'PROFESSIONAL', 'SINGLE'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.storage.uploadKycObject).not.toHaveBeenCalled();
  });

  it('MIME déclaré autorisé mais contenu non conforme → refusé', async () => {
    await expect(
      h.service.submitKycDocument(
        'tech-1',
        validFile({ mimetype: 'image/png', buffer: Buffer.from('ceci n est pas une image') }) as never,
        'PROFESSIONAL',
        'SINGLE',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fichier > 10 Mo → refusé avant tout stockage', async () => {
    await expect(
      h.service.submitKycDocument('tech-1', validFile({ size: 11 * 1024 * 1024 }) as never, 'PROFESSIONAL', 'SINGLE'),
    ).rejects.toThrow(/10 Mo/);
    expect(h.storage.uploadKycObject).not.toHaveBeenCalled();
  });

  it('type de document inconnu → refusé', async () => {
    await expect(
      h.service.submitKycDocument('tech-1', validFile() as never, 'PASSEPORT', 'SINGLE'),
    ).rejects.toThrow(/Type de document/);
  });
});

/* ── Verrouillage après validation (§20) ────────────────────────────────── */

describe('submitKycDocument — dossier déjà validé', () => {
  it('déposer après VERIFIED → 403 (le dossier devient immuable)', async () => {
    const h = makeHarness();
    h.prisma.technicianProfile.findUnique.mockResolvedValue(profileRow({ kycStatus: 'VERIFIED' }));
    await expect(
      h.service.submitKycDocument('tech-1', validFile() as never, 'PROFESSIONAL', 'SINGLE'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.storage.uploadKycObject).not.toHaveBeenCalled();
  });
});

/* ── Faces cohérentes avec la pièce déclarée (§15) ──────────────────────── */

describe('submitKycDocument — faces et pièce déclarée', () => {
  it('RECTO demandé sans type de pièce déclaré → 400', async () => {
    const h = makeHarness();
    await expect(
      h.service.submitKycDocument('tech-1', validFile() as never, 'IDENTITY', 'RECTO'),
    ).rejects.toThrow(/type de pi.+ce/);
  });

  it('VERSO demandé pour un PASSPORT → 400 (le passeport n’a pas de verso)', async () => {
    const h = makeHarness();
    h.prisma.technicianProfile.findUnique.mockResolvedValue(
      profileRow({ kycIdentityDocType: 'PASSPORT' }),
    );
    await expect(
      h.service.submitKycDocument('tech-1', validFile() as never, 'IDENTITY', 'VERSO'),
    ).rejects.toThrow(/verso/);
  });
});

/* ── Chemin de stockage (§16) ──────────────────────────────────────────── */

describe('submitKycDocument — chemin de stockage', () => {
  it('le dépôt est isolé par technicien et porte une extension déduite du MIME', async () => {
    const h = makeHarness();
    await h.service.submitKycDocument('tech-1', validFile() as never, 'PROFESSIONAL', 'SINGLE');
    expect(h.uploaded).toHaveLength(1);
    const path = h.uploaded[0];
    // Isolation par technicien : un technicianId ne peut pas écrire dans
    // l'espace d another's technicien.
    expect(path.startsWith('technicians/tech-1/kyc/')).toBe(true);
    // Nom non devinable : pas de nom de fichier d'origine dans le chemin.
    expect(path.endsWith('.png')).toBe(true);
    expect(path).not.toContain('carte');
  });
});

/* ── Consultation : propriété + URL signée (§16) ────────────────────────── */

describe('getKycDocumentUrl — contrôle d’accès', () => {
  it('document appartenant à un AUTRE technicien → 404 (pas de fuite d’existence)', async () => {
    const h = makeHarness();
    h.prisma.kycDocument.findFirst.mockResolvedValue(null);
    await expect(h.service.getKycDocumentUrl('tech-1', 'doc-autre')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it('URL signée à durée courte pour un document qui appartient bien au technicien', async () => {
    const h = makeHarness();
    h.prisma.kycDocument.findFirst.mockResolvedValue({
      storagePath: 'technicians/tech-1/kyc/x.png',
      mimeType: 'image/png',
    });
    const result = await h.service.getKycDocumentUrl('tech-1', 'doc-1');
    expect(result.expiresIn).toBe(300);
    expect(result.url).toBe('https://signed.example/doc');
  });
});

/* ── Absence de fuite de données sensibles (§26) ────────────────────────── */

describe('listKycDocuments — réponses API', () => {
  it('n’expose jamais le chemin de stockage Supabase', async () => {
    const h = makeHarness();
    h.prisma.kycDocument.findMany.mockResolvedValue([
      {
        id: 'doc-1',
        type: 'IDENTITY',
        side: 'RECTO',
        mimeType: 'image/png',
        originalName: 'carte.png',
        storagePath: 'technicians/tech-1/kyc/secret.png',
        size: 1234,
        createdAt: d('2025-01-01'),
      },
    ]);
    const overview = await h.service.listKycDocuments('tech-1');
    expect(overview.documents[0]).not.toHaveProperty('storagePath');
    // Aucune clé d'objet ne doit apparaître dans la sérialisation.
    expect(JSON.stringify(overview)).not.toContain('technicians/tech-1/kyc/secret.png');
  });
});

/* ── Complétude de la soumission (§14/§15) ──────────────────────────────── */

describe('submitKyc — contrôle de complétude', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(d('2025-10-04'));
  });

  it('CNI déclarée mais verso manquant → 400 nommant le verso', async () => {
    const h = makeHarness();
    h.prisma.technicianProfile.findUnique.mockResolvedValue(
      profileRow({
        birthDate: d('1990-01-01'),
        nationality: 'CM',
        kycIdentityDocType: 'NATIONAL_ID_CARD',
      }),
    );
    h.prisma.kycDocument.findMany.mockResolvedValue([kycRow('RECTO')]);
    await expect(h.service.submitKyc('tech-1')).rejects.toThrow(/verso/);
  });

  it('mineur (17 ans) → 403, jamais de passage en PENDING', async () => {
    const h = makeHarness();
    h.prisma.technicianProfile.findUnique.mockResolvedValue(
      profileRow({ birthDate: d('2007-10-05'), nationality: 'CM', kycIdentityDocType: 'PASSPORT' }),
    );
    await expect(h.service.submitKyc('tech-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.technicianProfile.update).not.toHaveBeenCalled();
  });

  it('dossier complet → passage en PENDING', async () => {
    const h = makeHarness();
    h.prisma.technicianProfile.findUnique.mockResolvedValue(
      profileRow({
        birthDate: d('1990-01-01'),
        nationality: 'CM',
        kycIdentityDocType: 'NATIONAL_ID_CARD',
      }),
    );
    h.prisma.kycDocument.findMany.mockResolvedValue([
      kycRow('RECTO'),
      kycRow('VERSO'),
    ]);
    await h.service.submitKyc('tech-1');
    expect(h.prisma.technicianProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { kycStatus: 'PENDING', kycRejectionReason: null } }),
    );
  });

  it('PASSEPORT complet → PENDING (régression : la soumission passeport était impossible)', async () => {
    // Un passeport n'a pas de verso et sa page est stockée en SINGLE. Exiger
    // « RECTO » pour un passeport rendait le dossier NON soumettable, car le
    // dépôt coerce toute pièce sans verso en SINGLE.
    const h = makeHarness();
    h.prisma.technicianProfile.findUnique.mockResolvedValue(
      profileRow({
        birthDate: d('1990-01-01'),
        nationality: 'CM',
        kycIdentityDocType: 'PASSPORT',
      }),
    );
    h.prisma.kycDocument.findMany.mockResolvedValue([kycRow('SINGLE')]);
    await h.service.submitKyc('tech-1');
    expect(h.prisma.technicianProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { kycStatus: 'PENDING', kycRejectionReason: null } }),
    );
  });

  it('PASSEPORT sans page → 400 nommant la page', async () => {
    const h = makeHarness();
    h.prisma.technicianProfile.findUnique.mockResolvedValue(
      profileRow({
        birthDate: d('1990-01-01'),
        nationality: 'CM',
        kycIdentityDocType: 'PASSPORT',
      }),
    );
    h.prisma.kycDocument.findMany.mockResolvedValue([]);
    await expect(h.service.submitKyc('tech-1')).rejects.toThrow(/page de votre passeport/);
  });

  it('déjà VERIFIED → 409 (aucune soumission possible)', async () => {
    const h = makeHarness();
    h.prisma.technicianProfile.findUnique.mockResolvedValue(profileRow({ kycStatus: 'VERIFIED' }));
    await expect(h.service.submitKyc('tech-1')).rejects.toThrow();
  });
});

/* ── Le dépôt ne transmet pas (§12 : soumission explicite) ─────────────── */

describe('submitKycDocument — le dépôt ne passe pas le dossier en attente', () => {
  it('déposer ne modifie AUCUN statut', async () => {
    const h = makeHarness();
    await h.service.submitKycDocument('tech-1', validFile() as never, 'PROFESSIONAL', 'SINGLE');
    // Le parcours dispose d'une soumission EXPLICITE : faire passer le statut à
    // PENDING au premier dépôt envoyait un dossier INCOMPLET chez l'admin et
    // retirait au technicien le bouton « Transmettre » (la section 5 est
    // masquée en PENDING) sans possibilité de corriger.
    expect(h.prisma.technicianProfile.update).not.toHaveBeenCalled();
  });
});