import { describe, expect, it, vi } from 'vitest';
import { AiPricingCheckService, comparePriceToScale } from './ai-pricing-check.service.js';

/* IA-6 — surveillance DÉTERMINISTE des tarifs (Prisma mocké) : comparaison
 * sans LLM, snapshot immuable, non-blocage, idempotence, permissions via
 * les gardes existantes (aucune route ajoutée). Aucun appel réseau. */

describe('comparePriceToScale — pur, sans LLM, null jamais 0', () => {
  it('dans les bornes → NORMAL, sans écart', () => {
    expect(comparePriceToScale(35000, { min: 30000, reference: 35000, max: 40000 })).toEqual({
      result: 'NORMAL',
      deviationAmount: null,
      deviationBps: null,
    });
  });

  it.each([
    ['prix = min', 30000],
    ['prix = max', 40000],
  ])('%s → NORMAL (pas de faux signal aux bornes)', (_label, price) => {
    expect(comparePriceToScale(price, { min: 30000, reference: 35000, max: 40000 }).result).toBe('NORMAL');
  });

  it('au-dessus du max → ABOVE_MAX + écarts entiers', () => {
    expect(comparePriceToScale(85000, { min: 30000, reference: 50000, max: 80000 })).toEqual({
      result: 'ABOVE_MAX',
      deviationAmount: 5000,
      deviationBps: 1000,
    });
  });

  it('en dessous du min → BELOW_MIN + écarts entiers', () => {
    expect(comparePriceToScale(20000, { min: 30000, reference: 35000, max: 40000 })).toEqual({
      result: 'BELOW_MIN',
      deviationAmount: 10000,
      deviationBps: 2857,
    });
  });

  it('bornes partielles : min null + max respecté → NORMAL (min inconclu)', () => {
    expect(comparePriceToScale(90000, { min: null, reference: 80000, max: 100000 }).result).toBe('NORMAL');
  });

  it.each([
    ['min uniquement, au-dessus', 50000, { min: 30000, reference: null, max: null }, 'NORMAL'],
    ['min uniquement, en dessous', 20000, { min: 30000, reference: null, max: null }, 'BELOW_MIN'],
    ['max uniquement, en dessous', 50000, { min: null, reference: null, max: 80000 }, 'NORMAL'],
    ['max uniquement, au-dessus', 90000, { min: null, reference: null, max: 80000 }, 'ABOVE_MAX'],
    ['référence uniquement', 999999, { min: null, reference: 35000, max: null }, 'NORMAL'],
    ['min + max, dedans', 35000, { min: 30000, reference: null, max: 40000 }, 'NORMAL'],
    ['min + référence, dedans', 35000, { min: 30000, reference: 35000, max: null }, 'NORMAL'],
    ['référence + max, dedans', 35000, { min: null, reference: 35000, max: 40000 }, 'NORMAL'],
  ])('%s', (_label, price, scale, expected) => {
    expect(comparePriceToScale(price, scale as never).result).toBe(expected);
  });

  it('sans référence > 0 → écart relatif null (pas de division)', () => {
    expect(comparePriceToScale(90000, { min: null, reference: null, max: 80000 })).toEqual({
      result: 'ABOVE_MAX',
      deviationAmount: 10000,
      deviationBps: null,
    });
  });
});

function checkService(options: {
  quote?: Record<string, unknown> | null;
  existing?: Record<string, unknown> | null;
  match?: Record<string, unknown> | null;
  diagnostic?: Record<string, unknown> | null;
  pricings?: Array<Record<string, unknown>>;
  pending?: Array<{ id: string }>;
} = {}) {
  const upserted: unknown[] = [];
  const prisma = {
    quote: {
      findUnique: vi.fn(async () => options.quote ?? null),
      findMany: vi.fn(async () => options.pending ?? []),
    },
    quotePricingCheck: {
      findUnique: vi.fn(async () => options.existing ?? null),
      upsert: vi.fn(async ({ create }: { create: unknown }) => {
        upserted.push(create);
        return { id: 'chk-1', ...create };
      }),
      findMany: vi.fn(async () => []),
    },
    diagnosticCatalogMatch: { findUnique: vi.fn(async () => options.match ?? null) },
    catalogDiagnostic: {
      findUnique: vi.fn(async () => options.diagnostic ?? null),
    },
  };
  return { service: new AiPricingCheckService(prisma as never), prisma, upserted };
}

const QUOTE = {
  id: 'q-1',
  demandeId: 'd-1',
  diagnosticId: 'dg-1',
  amount: 85000,
  source: 'MANUAL',
};

const MATCHED = {
  classification: 'MATCHED',
  catalogDiagnosticId: 'cd-1',
};

function activeScale() {
  return {
    id: 'cd-1',
    isActive: true,
    interventions: [
      {
        id: 'i-1',
        pricing: { id: 'p-1', minPrice: 30000, referencePrice: 50000, maxPrice: 80000, isActive: true },
      },
    ],
  };
}

describe('evaluateManualQuote — statuts et snapshot', () => {
  it('prix dans min/max → NORMAL + snapshot figé', async () => {
    const { service, upserted } = checkService({
      quote: { ...QUOTE, amount: 50000 },
      match: MATCHED,
      diagnostic: activeScale(),
    });
    const row = await service.evaluateManualQuote('q-1');
    expect(row).toMatchObject({ result: 'NORMAL', proposedPrice: 50000 });
    expect(upserted).toHaveLength(1);
    const created = upserted[0] as Record<string, unknown>;
    expect(created).toMatchObject({
      minAtCheck: 30000,
      referenceAtCheck: 50000,
      maxAtCheck: 80000,
      pricingIds: ['p-1'],
      deviationAmount: null,
    });
  });

  it('prix > max → ABOVE_MAX (devis accepté : non bloqué, quote intacte)', async () => {
    const { service } = checkService({ quote: QUOTE, match: MATCHED, diagnostic: activeScale() });
    const row = await service.evaluateManualQuote('q-1');
    expect(row).toMatchObject({ result: 'ABOVE_MAX', proposedPrice: 85000, deviationAmount: 5000, deviationBps: 1000 });
  });

  it('prix < min → BELOW_MIN', async () => {
    const { service } = checkService({
      quote: { ...QUOTE, amount: 20000 },
      match: MATCHED,
      diagnostic: activeScale(),
    });
    const row = await service.evaluateManualQuote('q-1');
    expect(row).toMatchObject({ result: 'BELOW_MIN', deviationAmount: 10000 });
  });

  it('sans match (UNCERTAIN/UNMATCHED) → NO_BAREME, devis accepté', async () => {
    for (const match of [null, { classification: 'UNCERTAIN' }, { classification: 'UNMATCHED' }]) {
      const { service } = checkService({ quote: QUOTE, match, diagnostic: activeScale() });
      const row = await service.evaluateManualQuote('q-1');
      expect(row).toMatchObject({ result: 'NO_BAREME' });
    }
  });

  it('diagnostic désactivé → UNCERTAIN (pas de comparaison invalide)', async () => {
    const { service } = checkService({
      quote: QUOTE,
      match: MATCHED,
      diagnostic: { ...activeScale(), isActive: false },
    });
    const row = await service.evaluateManualQuote('q-1');
    expect(row).toMatchObject({ result: 'UNCERTAIN', reason: 'INACTIVE_SCALE' });
  });

  it('aucun pricing actif → NO_BAREME', async () => {
    const { service } = checkService({
      quote: QUOTE,
      match: MATCHED,
      diagnostic: { id: 'cd-1', isActive: true, interventions: [] },
    });
    const row = await service.evaluateManualQuote('q-1');
    expect(row).toMatchObject({ result: 'NO_BAREME', reason: 'NO_PRICING' });
  });

  it('devis CATALOG → ignoré (null, parcours intact)', async () => {
    const { service, prisma } = checkService({
      quote: { ...QUOTE, source: 'CATALOG' },
      match: MATCHED,
      diagnostic: activeScale(),
    });
    expect(await service.evaluateManualQuote('q-1')).toBeNull();
    expect(prisma.quotePricingCheck.upsert).not.toHaveBeenCalled();
  });
});

describe('snapshot : barème modifié après devis → contrôle historique intact', () => {
  it('le snapshot figé ne suit pas le nouveau barème', async () => {
    const first = checkService({ quote: QUOTE, match: MATCHED, diagnostic: activeScale() });
    const row = await first.service.evaluateManualQuote('q-1');
    expect(row).toMatchObject({ result: 'ABOVE_MAX', maxAtCheck: 80000 });
    // L'admin monte le max à 200 000 : un nouveau contrôle du MÊME devis
    // retrouverait la ligne existante (idempotence), jamais réécrite.
    const second = checkService({
      quote: QUOTE,
      existing: row,
      match: MATCHED,
      diagnostic: {
        ...activeScale(),
        interventions: [
          { id: 'i-1', pricing: { id: 'p-1', minPrice: 30000, referencePrice: 50000, maxPrice: 200000, isActive: true } },
        ],
      },
    });
    const again = await second.service.evaluateManualQuote('q-1');
    expect(again).toMatchObject({ maxAtCheck: 80000, result: 'ABOVE_MAX' });
    expect(second.prisma.quotePricingCheck.upsert).not.toHaveBeenCalled();
  });
});

describe('idempotence : un événement → un contrôle', () => {
  it('ligne existante → retournée sans écriture', async () => {
    const existing = { id: 'chk-0', result: 'NORMAL' };
    const { service, prisma } = checkService({ quote: QUOTE, existing, match: MATCHED, diagnostic: activeScale() });
    expect(await service.evaluateManualQuote('q-1')).toBe(existing);
    expect(prisma.quotePricingCheck.upsert).not.toHaveBeenCalled();
  });
});

describe('evaluatePendingQuotesForMatch — mapping tardif', () => {
  it('devis PENDING sans contrôle → contrôlé ; autres ignorés', async () => {
    const evaluated: string[] = [];
    const prisma = {
      quote: {
        findMany: vi.fn(async () => [{ id: 'q-pending' }, { id: 'q-done' }]),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'q-pending'
            ? { ...QUOTE, id: 'q-pending', status: 'PENDING', source: 'MANUAL' }
            : null,
        ),
      },
      quotePricingCheck: {
        findUnique: vi.fn(async ({ where }: { where: { quoteId: string } }) =>
          where.quoteId === 'q-done' ? { id: 'chk-old', result: 'NORMAL' } : null,
        ),
        upsert: vi.fn(async ({ create }: { create: { quoteId: string } }) => {
          evaluated.push(create.quoteId as string);
          return { id: 'chk-new', ...create };
        }),
        findMany: vi.fn(async () => []),
      },
      diagnosticCatalogMatch: { findUnique: vi.fn(async () => MATCHED) },
      catalogDiagnostic: {
        findUnique: vi.fn(async () => activeScale()),
      },
    };
    const service = new AiPricingCheckService(prisma as never);
    await service.evaluatePendingQuotesForMatch('dg-1');
    expect(evaluated).toEqual(['q-pending']);
    expect(prisma.quote.findMany).toHaveBeenCalledWith({
      where: { diagnosticId: 'dg-1', source: 'MANUAL', status: 'PENDING', pricingCheck: { is: null } },
      select: { id: true },
    });
  });
});
