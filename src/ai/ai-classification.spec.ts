import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiConfig } from './ai.config.js';
import { AiClassificationService } from './ai-classification.service.js';
import { AiInvalidResponseException, AiUpstreamException } from './ai-errors.js';
import { selectCandidatesForWave, type DispatchCandidate } from '../dispatch/dispatch.service.js';

/* IA-4 — classification des demandes « Autre » (gateway stubé, Prisma
 * mocké) : valide, confiance faible, domaine inventé, invalide, désactivée,
 * indisponible, idempotence + enrichissement dispatch sans IA directe.
 * Aucun appel réseau réel, aucun workflow métier modifié. */

const DOMAINS = [
  { id: 'dom-plomberie', name: 'Plomberie', isActive: true },
  { id: 'dom-inactif', name: 'Ancien', isActive: false },
];

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
      demandeClassification: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async ({ create }: { create: unknown }) => create),
      },
      serviceDomain: {
        findMany: vi.fn(async () => DOMAINS.filter((d) => d.isActive).map(({ id, name }) => ({ id, name }))),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => DOMAINS.find((d) => d.id === where.id) ?? null),
      },
    } as never);
  const gateway =
    options.gateway ??
    ({
      completeJson: vi.fn(async () => ({
        result: {},
        model: 'm',
        durationMs: 1,
      })),
    } as never);
  const aiConfig = new AiConfig(configService as never);
  return new AiClassificationService(prisma as never, configService as never, gateway as never, aiConfig);
}

function gatewayOk(result: unknown) {
  return {
    completeJson: vi.fn(async () => ({ result, model: 'openai/gpt-4o-mini', durationMs: 5 })),
  };
}

const BASE_INPUT = {
  demandeId: 'd-autre',
  deviceLabel: 'Appareil non répertorié',
  description: "Un truc qui fait du bruit dans la cuisine.",
  city: 'Douala',
  mediaKinds: ['AUDIO'],
};

describe('classification valide → acceptée et persistée', () => {
  it('domainId actif + confiance 0.9 → CLASSIFIED, catégories filtrées', async () => {
    const upsert = vi.fn(async ({ create }: { create: unknown }) => create);
    const svc = service({
      prisma: {
        demandeClassification: { findUnique: vi.fn(async () => null), upsert },
        serviceDomain: {
          findMany: vi.fn(async () => [{ id: 'dom-plomberie', name: 'Plomberie' }]),
          findUnique: vi.fn(async () => ({ id: 'dom-plomberie', isActive: true })),
        },
      },
      gateway: gatewayOk({
        domainId: 'dom-plomberie',
        confidence: 0.9,
        suggestedCategories: ['plomberie', 'inconnue-xyz'],
        reason: 'Bruit de canalisation.',
        classification: 'CLASSIFIED',
      }),
    });
    const outcome = await svc.classifyAutreDemande(BASE_INPUT);
    expect(outcome.classification).toBe('CLASSIFIED');
    expect(outcome.domainId).toBe('dom-plomberie');
    expect(outcome.categories).toEqual(['plomberie']);
    expect(outcome.confidence).toBe(0.9);
    expect(outcome.reason).toBe('OK');
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe('confiance faible → UNCERTAIN + fallback', () => {
  it('confidence 0.4 < seuil 0.7 → UNCERTAIN, domaine non retenu', async () => {
    const svc = service({
      gateway: gatewayOk({
        domainId: 'dom-plomberie',
        confidence: 0.4,
        suggestedCategories: ['plomberie'],
        reason: 'Doute.',
        classification: 'CLASSIFIED',
      }),
    });
    const outcome = await svc.classifyAutreDemande(BASE_INPUT);
    expect(outcome.classification).toBe('UNCERTAIN');
    expect(outcome.domainId).toBeNull();
    expect(outcome.reason).toBe('LOW_CONFIDENCE');
  });
});

describe('domaine inventé → rejet + fallback', () => {
  it('domainId inexistant → UNCLASSIFIABLE UNKNOWN_DOMAIN', async () => {
    const svc = service({
      gateway: gatewayOk({
        domainId: 'dom-invente-xyz',
        confidence: 0.95,
        suggestedCategories: ['plomberie'],
        reason: 'Hallucination.',
        classification: 'CLASSIFIED',
      }),
    });
    const outcome = await svc.classifyAutreDemande(BASE_INPUT);
    expect(outcome.classification).toBe('UNCLASSIFIABLE');
    expect(outcome.domainId).toBeNull();
    expect(outcome.reason).toBe('UNKNOWN_DOMAIN');
  });

  it('domaine inactif → rejeté', async () => {
    const svc = service({
      gateway: gatewayOk({
        domainId: 'dom-inactif',
        confidence: 0.95,
        suggestedCategories: [],
        reason: 'Ancien domaine.',
        classification: 'CLASSIFIED',
      }),
    });
    const outcome = await svc.classifyAutreDemande(BASE_INPUT);
    expect(outcome.classification).toBe('UNCLASSIFIABLE');
  });
});

describe('réponse JSON invalide → fallback', () => {
  it('gateway AiInvalidResponse → UNCLASSIFIABLE, sans exception', async () => {
    const svc = service({
      gateway: { completeJson: vi.fn(async () => { throw new AiInvalidResponseException('x'); }) },
    });
    const outcome = await svc.classifyAutreDemande(BASE_INPUT);
    expect(outcome.classification).toBe('UNCLASSIFIABLE');
  });
});

describe('IA désactivée → aucun appel, dispatch inchangé', () => {
  it('AI_ENABLED=false → UNCLASSIFIABLE AI_DISABLED, gateway jamais appelé', async () => {
    const gateway = { completeJson: vi.fn() };
    const svc = service({ env: { AI_ENABLED: 'false' }, gateway });
    const outcome = await svc.classifyAutreDemande(BASE_INPUT);
    expect(outcome.classification).toBe('UNCLASSIFIABLE');
    expect(outcome.reason).toBe('AI_DISABLED');
    expect(gateway.completeJson).not.toHaveBeenCalled();
  });
});

describe('Provider IA indisponible → demande non bloquée', () => {
  it.each([
    ['timeout', new AiUpstreamException('timeout')],
    ['500', new AiUpstreamException('boom', 500)],
    ['429-upstream', new AiUpstreamException('rate', 429)],
  ])('%s → UNCLASSIFIABLE, jamais d’exception', async (_label, error) => {
    const svc = service({ gateway: { completeJson: vi.fn(async () => { throw error; }) } });
    const outcome = await svc.classifyAutreDemande(BASE_INPUT);
    expect(outcome.classification).toBe('UNCLASSIFIABLE');
  });
});

describe('idempotence : existant rejoué sans nouvel appel', () => {
  it('ligne existante → retournée telle quelle, gateway non appelé', async () => {
    const existing = {
      classification: 'CLASSIFIED',
      domainId: 'dom-plomberie',
      categories: ['plomberie'],
      confidence: 0.9,
      model: 'm',
      reason: 'OK',
    };
    const gateway = { completeJson: vi.fn() };
    const svc = service({
      gateway,
      prisma: {
        demandeClassification: { findUnique: vi.fn(async () => existing), upsert: vi.fn() },
        serviceDomain: { findMany: vi.fn(), findUnique: vi.fn() },
      },
    });
    const outcome = await svc.classifyAutreDemande(BASE_INPUT);
    expect(outcome).toMatchObject({ classification: 'CLASSIFIED', domainId: 'dom-plomberie' });
    expect(gateway.completeJson).not.toHaveBeenCalled();
  });
});

function candidate(userId: string, categories: string[]): DispatchCandidate {
  return {
    userId,
    email: null,
    city: 'Douala',
    cityId: 'city-1',
    categories,
    isAvailable: true,
    kycStatus: 'VERIFIED',
    coverageZoneIds: [],
  };
}

const AUTRE_GEO = { city: 'Douala', cityId: 'city-1', zoneId: null as string | null, category: 'autre' };

describe('Autre → dispatch enrichi, jamais de sélection IA directe', () => {
  it('sans signal : technicien plomberie NON notifié pour « autre »', () => {
    const selected = selectCandidatesForWave([candidate('t-plomb', ['plomberie'])], AUTRE_GEO, 1, []);
    expect(selected).toHaveLength(0);
  });

  it('avec signal : même technicien notifié (règles ville/dispo intactes)', () => {
    const selected = selectCandidatesForWave([candidate('t-plomb', ['plomberie'])], AUTRE_GEO, 1, [], ['plomberie']);
    expect(selected.map((c) => c.userId)).toEqual(['t-plomb']);
  });

  it('indisponible ou hors ville : toujours exclu même avec signal', () => {
    const off = { ...candidate('t-off', ['plomberie']), isAvailable: false };
    expect(selectCandidatesForWave([off], AUTRE_GEO, 1, [], ['plomberie'])).toHaveLength(0);
    const far = { ...candidate('t-far', ['plomberie']), city: 'Yaoundé', cityId: 'city-2' };
    expect(selectCandidatesForWave([far], AUTRE_GEO, 1, [], ['plomberie'])).toHaveLength(0);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
