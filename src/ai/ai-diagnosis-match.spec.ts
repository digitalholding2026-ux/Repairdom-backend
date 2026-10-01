import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiConfig } from './ai.config.js';
import { AiDiagnosisMatchService } from './ai-diagnosis-match.service.js';
import { AiInvalidResponseException, AiUpstreamException } from './ai-errors.js';

/* IA-5 — mapping diagnostic libre → catalogue (gateway stubé, Prisma
 * mocké) : match fiable, confiance faible, aucun candidat, ID inventé,
 * inactif, IA désactivée, indisponible, MANUAL conservé, idempotence,
 * permissions. Aucun appel réseau réel, aucun workflow modifié. */

const CANDIDATES = [
  { id: 'cd-ecran', name: "Remplacement écran", problem: { name: 'Écran cassé', domainId: 'dom-tel', domain: { name: 'Smartphone' } } },
  { id: 'cd-batterie', name: 'Remplacement batterie', problem: { name: 'Batterie faible', domainId: 'dom-tel', domain: { name: 'Smartphone' } } },
];

const DIAGNOSTIC = {
  id: 'dg-1',
  content: "L'écran présente des lignes verticales et une zone noire après une chute.",
  recommendation: null,
  justification: null,
  notes: null,
  audioStoragePath: null,
  technicianId: 't-1',
  demande: { id: 'd-1', clientId: 'c-1', technicianId: 't-1', domainId: 'dom-tel', category: 'informatique' },
};

function service(options: {
  env?: Record<string, string | undefined>;
  gateway?: unknown;
  prisma?: unknown;
} = {}) {
  const env = {
    AI_ENABLED: 'true',
    GROQ_API_KEY: 'gsk-test-UNIT',
    AI_CLASSIFICATION_MIN_CONFIDENCE: '0.7',
    ...options.env,
  };
  const configService = { get: (key: string) => env[key] };
  const prisma =
    options.prisma ??
    ({
      diagnostic: { findFirst: vi.fn(async () => DIAGNOSTIC) },
      diagnosticCatalogMatch: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async ({ create }: { create: unknown }) => create),
      },
      catalogDiagnostic: {
        findMany: vi.fn(async () => CANDIDATES),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          isActive: true,
        })),
      },
    } as never);
  const gateway = options.gateway ?? ({ completeJson: vi.fn(async () => ({ result: {}, model: 'm', durationMs: 1 })) } as never);
  return new AiDiagnosisMatchService(
    prisma as never,
    gateway as never,
    new AiConfig(configService as never),
    { evaluatePendingQuotesForMatch: vi.fn(async () => undefined) } as never,
  );
}

function gatewayOk(result: unknown) {
  return { completeJson: vi.fn(async () => ({ result, model: 'openai/gpt-4o-mini', durationMs: 5 })) };
}

const ACTOR = { userId: 't-1', role: 'TECHNICIAN' };

describe('match fiable → MATCHED, diagnostic intact', () => {
  it('catalogue valide + confiance 0.92 → MATCHED, mode/texte conservés', async () => {
    const upsert = vi.fn(async ({ create }: { create: unknown }) => create);
    const diagnosticUpdate = vi.fn();
    const svc = service({
      prisma: {
        diagnostic: { findFirst: vi.fn(async () => DIAGNOSTIC), update: diagnosticUpdate },
        diagnosticCatalogMatch: { findUnique: vi.fn(async () => null), upsert },
        catalogDiagnostic: {
          findMany: vi.fn(async () => CANDIDATES),
          findUnique: vi.fn(async () => ({ id: 'cd-ecran', isActive: true })),
        },
      },
      gateway: gatewayOk({
        catalogDiagnosticId: 'cd-ecran',
        confidence: 0.92,
        classification: 'MATCHED',
        reason: 'Lignes verticales + zone noire = écran.',
      }),
    });
    const outcome = await svc.mapFreeDiagnostic(ACTOR, 'd-1', 'dg-1');
    expect(outcome.classification).toBe('MATCHED');
    expect(outcome.catalogDiagnosticId).toBe('cd-ecran');
    expect(outcome.confidence).toBe(0.92);
    expect(outcome.reason).toBe('OK');
    expect(diagnosticUpdate).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe('confiance faible → UNCERTAIN, diagnostic inchangé', () => {
  it('0.3 < seuil → UNCERTAIN, catalogDiagnosticId null', async () => {
    const svc = service({
      gateway: gatewayOk({
        catalogDiagnosticId: 'cd-ecran',
        confidence: 0.3,
        classification: 'MATCHED',
        reason: 'Doute.',
      }),
    });
    const outcome = await svc.mapFreeDiagnostic(ACTOR, 'd-1', 'dg-1');
    expect(outcome.classification).toBe('UNCERTAIN');
    expect(outcome.catalogDiagnosticId).toBeNull();
  });
});

describe('aucun candidat → UNMATCHED sans appel IA', () => {
  it('catalogue vide pour le domaine → NO_CANDIDATE, gateway non appelé', async () => {
    const gateway = { completeJson: vi.fn() };
    const svc = service({
      gateway,
      prisma: {
        diagnostic: { findFirst: vi.fn(async () => DIAGNOSTIC) },
        diagnosticCatalogMatch: {
          findUnique: vi.fn(async () => null),
          upsert: vi.fn(async ({ create }: { create: unknown }) => create),
        },
        catalogDiagnostic: { findMany: vi.fn(async () => []), findUnique: vi.fn() },
      },
    });
    const outcome = await svc.mapFreeDiagnostic(ACTOR, 'd-1', 'dg-1');
    expect(outcome.classification).toBe('UNMATCHED');
    expect(outcome.reason).toBe('NO_CANDIDATE');
    expect(gateway.completeJson).not.toHaveBeenCalled();
  });
});

describe('ID inventé → rejet UNMATCHED', () => {
  it('catalogDiagnosticId hors candidats → UNKNOWN_DIAGNOSTIC', async () => {
    const svc = service({
      gateway: gatewayOk({
        catalogDiagnosticId: 'cd-invente-xyz',
        confidence: 0.99,
        classification: 'MATCHED',
        reason: 'Hallucination.',
      }),
    });
    const outcome = await svc.mapFreeDiagnostic(ACTOR, 'd-1', 'dg-1');
    expect(outcome.classification).toBe('UNMATCHED');
    expect(outcome.catalogDiagnosticId).toBeNull();
    expect(outcome.reason).toBe('UNKNOWN_DIAGNOSTIC');
  });
});

describe('diagnostic inactif → rejet UNMATCHED', () => {
  it('candidat désactivé entre-temps → INACTIVE_DIAGNOSTIC', async () => {
    const svc = service({
      prisma: {
        diagnostic: { findFirst: vi.fn(async () => DIAGNOSTIC) },
        diagnosticCatalogMatch: {
          findUnique: vi.fn(async () => null),
          upsert: vi.fn(async ({ create }: { create: unknown }) => create),
        },
        catalogDiagnostic: {
          findMany: vi.fn(async () => CANDIDATES),
          findUnique: vi.fn(async () => ({ id: 'cd-ecran', isActive: false })),
        },
      },
      gateway: gatewayOk({
        catalogDiagnosticId: 'cd-ecran',
        confidence: 0.9,
        classification: 'MATCHED',
        reason: 'Écran.',
      }),
    });
    const outcome = await svc.mapFreeDiagnostic(ACTOR, 'd-1', 'dg-1');
    expect(outcome.classification).toBe('UNMATCHED');
    expect(outcome.reason).toBe('INACTIVE_DIAGNOSTIC');
  });
});

describe('IA désactivée → aucun appel, workflow intact', () => {
  it('AI_ENABLED=false → UNMATCHED AI_DISABLED, gateway non appelé', async () => {
    const gateway = { completeJson: vi.fn() };
    const svc = service({ env: { AI_ENABLED: 'false' }, gateway });
    const outcome = await svc.mapFreeDiagnostic(ACTOR, 'd-1', 'dg-1');
    expect(outcome.classification).toBe('UNMATCHED');
    expect(outcome.reason).toBe('AI_DISABLED');
    expect(gateway.completeJson).not.toHaveBeenCalled();
  });
});

describe('timeout / 429 / 500 → fallback, workflow intact', () => {
  it.each([
    ['timeout', new AiUpstreamException('timeout')],
    ['500', new AiUpstreamException('boom', 500)],
    ['429', new AiUpstreamException('rate', 429)],
    ['invalide', new AiInvalidResponseException('x')],
  ])('%s → UNMATCHED sans exception', async (_label, error) => {
    const svc = service({ gateway: { completeJson: vi.fn(async () => { throw error; }) } });
    const outcome = await svc.mapFreeDiagnostic(ACTOR, 'd-1', 'dg-1');
    expect(outcome.classification).toBe('UNMATCHED');
  });
});

describe('idempotence : existant rejoué sans nouvel appel', () => {
  it('match existant → retourné tel quel', async () => {
    const existing = {
      classification: 'MATCHED',
      catalogDiagnosticId: 'cd-ecran',
      confidence: 0.92,
      model: 'm',
      reason: 'OK',
    };
    const gateway = { completeJson: vi.fn() };
    const svc = service({
      gateway,
      prisma: {
        diagnostic: { findFirst: vi.fn(async () => DIAGNOSTIC) },
        diagnosticCatalogMatch: { findUnique: vi.fn(async () => existing), upsert: vi.fn() },
        catalogDiagnostic: { findMany: vi.fn(), findUnique: vi.fn() },
      },
    });
    const outcome = await svc.mapFreeDiagnostic(ACTOR, 'd-1', 'dg-1');
    expect(outcome).toMatchObject({ classification: 'MATCHED', catalogDiagnosticId: 'cd-ecran' });
    expect(gateway.completeJson).not.toHaveBeenCalled();
  });
});

describe('permissions : acteur non autorisé → 404', () => {
  it('autre technicien → NotFound, aucun appel IA', async () => {
    const gateway = { completeJson: vi.fn() };
    const svc = service({ gateway });
    await expect(
      svc.mapFreeDiagnostic({ userId: 't-9', role: 'TECHNICIAN' }, 'd-1', 'dg-1'),
    ).rejects.toMatchObject({ status: 404 });
    expect(gateway.completeJson).not.toHaveBeenCalled();
  });

  it('client propriétaire → autorisé (lecture du mapping de sa mission)', async () => {
    const svc = service({
      gateway: gatewayOk({
        catalogDiagnosticId: 'cd-ecran',
        confidence: 0.9,
        classification: 'MATCHED',
        reason: 'Écran.',
      }),
    });
    const outcome = await svc.mapFreeDiagnostic({ userId: 'c-1', role: 'CLIENT' }, 'd-1', 'dg-1');
    expect(outcome.classification).toBe('MATCHED');
  });
});

describe('contexte modèle : le mapping identifie catégorie + modèle', () => {
  const DIAG_MODEL = {
    ...DIAGNOSTIC,
    demande: { ...DIAGNOSTIC.demande, brandId: 'b-ios', modelId: 'm-11' },
  };
  const MODEL_CANDIDATES = [
    {
      id: 'cd-gen',
      name: 'Afficheur générique',
      problem: {
        name: 'Afficheur',
        slug: 'afficheur',
        domainId: 'dom-tel',
        modelId: null,
        brandId: null,
        domain: { name: 'Smartphone' },
        brand: null,
        model: null,
      },
    },
    {
      id: 'cd-tecno',
      name: 'Afficheur Tecno',
      problem: {
        name: 'Afficheur',
        slug: 'afficheur',
        domainId: 'dom-tel',
        modelId: 'm-tecno',
        brandId: 'b-android',
        domain: { name: 'Smartphone' },
        brand: { name: 'Android' },
        model: { name: 'Tecno Spark' },
      },
    },
    {
      id: 'cd-11',
      name: 'Afficheur iPhone 11',
      problem: {
        name: 'Afficheur',
        slug: 'afficheur',
        domainId: 'dom-tel',
        modelId: 'm-11',
        brandId: 'b-ios',
        domain: { name: 'Smartphone' },
        brand: { name: 'iOS' },
        model: { name: 'iPhone 11' },
      },
    },
  ];

  it('candidat du modèle mission en premier, libellé « modèle : iPhone 11 »', async () => {
    let system = '';
    const gateway = {
      completeJson: vi.fn(async ({ messages }: { messages: Array<{ content: string }> }) => {
        system = messages[0].content;
        return {
          result: { catalogDiagnosticId: 'cd-11', confidence: 0.9, classification: 'MATCHED', reason: 'Ok.' },
          model: 'm',
          durationMs: 1,
        };
      }),
    };
    const upsert = vi.fn(async ({ create }: { create: unknown }) => create);
    const svc = service({
      gateway,
      prisma: {
        diagnostic: { findFirst: vi.fn(async () => DIAG_MODEL) },
        diagnosticCatalogMatch: { findUnique: vi.fn(async () => null), upsert },
        catalogDiagnostic: {
          findMany: vi.fn(async () => MODEL_CANDIDATES),
          findUnique: vi.fn(async () => ({ id: 'cd-11', isActive: true })),
        },
      },
    });
    const outcome = await svc.mapFreeDiagnostic(ACTOR, 'd-1', 'dg-1');
    expect(outcome).toMatchObject({ classification: 'MATCHED', catalogDiagnosticId: 'cd-11' });
    const lines = system.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(3);
    // Le diagnostic du modèle de la mission passe en premier, avec son modèle.
    expect(lines[0]).toContain('cd-11');
    expect(lines[0]).toContain('modèle : iPhone 11');
    // Le générique reste proposable, explicitement « tous modèles ».
    expect(system).toContain('tous modèles');
    expect(system).toContain('cd-tecno');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
