import { describe, expect, it, vi } from 'vitest';
import { SasPayTopupService } from './saspay-topup.service.js';
import { SasPayTerminalException, SasPayUpstreamException } from './saspay-api.client.js';

/* Sprint SASPAY-03 — orchestration init/verify (dépendances mockées) :
 * gates REAL/config/clé, init idempotente, erreurs terminales vs rejouables,
 * vérification serveur sans polling. */

type Row = Record<string, any>;

function mockDeps(overrides: {
  financialMode?: string;
  configured?: boolean;
  keyMismatch?: string | null;
  intent?: Row | null;
  initResult?: unknown;
  initError?: unknown;
  verifyResult?: unknown;
} = {}) {
  const intent: Row =
    overrides.intent ?? {
      id: 'ti-1',
      reference: 'TOPUP-1',
      idempotencyKey: 'key-1',
      userId: 'c1',
      amount: 5000,
      currency: 'XAF',
      mode: 'REAL',
      status: 'PENDING',
      saspayTransactionId: null,
      saspayReference: null,
      externalReference: null,
      network: 'mtn_cm',
      country: 'CM',
      fee: null,
      chargedAmount: null,
      netAmount: null,
      creditedTransactionId: null,
      metadata: { phone: '+237690000000' },
      createdById: 'c1',
    };
  const prisma = {
    topupIntent: {
      findUnique: vi.fn(async () => (overrides.intent === null ? null : { ...intent, user: { id: 'c1', firstName: 'Awa', lastName: 'S', email: 'c@example.com' } })),
      update: vi.fn(async ({ data }: any) => Object.assign(intent, data)),
    },
  };
  const financial = {
    getMode: vi.fn(() => overrides.financialMode ?? 'REAL'),
    failTopupIntent: vi.fn(async () => ({ reference: intent.reference, status: 'FAILED' })),
    cancelTopupIntent: vi.fn(async () => ({ reference: intent.reference, status: 'CANCELLED' })),
    confirmTopupFromSasPay: vi.fn(async () => ({ intent: { reference: intent.reference, status: 'SUCCESS' }, credited: true })),
    getTopupIntentForOwner: vi.fn(async () => ({ reference: intent.reference, status: intent.status })),
  };
  const api = {
    initializeSoftpay: overrides.initError
      ? vi.fn(async () => { throw overrides.initError; })
      : vi.fn(async () => overrides.initResult ?? { id: 'pay-1', status: 'PENDING', checkoutUrl: null, message: 'ok' }),
    verifyPayment: vi.fn(async () => overrides.verifyResult ?? null),
  };
  const saspayConfig = {
    isConfigured: vi.fn(() => overrides.configured ?? true),
    keyModeMismatch: vi.fn(() => overrides.keyMismatch ?? null),
  };
  const config = { get: vi.fn((k: string) => (k === 'FRONTEND_URL' ? 'https://relio.test' : undefined)) };
  const service = new SasPayTopupService(prisma as never, financial as never, api as never, saspayConfig as never, config as never);
  return { service, prisma, financial, api, intent };
}

describe('gates : SIMULATION / config / clé', () => {
  it('SIMULATION → 403, aucun appel SasPay', async () => {
    const { service, api } = mockDeps({ financialMode: 'SIMULATION' });
    await expect(service.initializeTopupPayment('c1', 'TOPUP-1')).rejects.toMatchObject({ status: 403 });
    expect(api.initializeSoftpay).not.toHaveBeenCalled();
  });

  it('config incomplète → 503, aucun appel', async () => {
    const { service, api } = mockDeps({ configured: false });
    await expect(service.initializeTopupPayment('c1', 'TOPUP-1')).rejects.toMatchObject({ status: 503 });
    expect(api.initializeSoftpay).not.toHaveBeenCalled();
  });

  it('clé live en TEST → 503 explicite', async () => {
    const { service, api } = mockDeps({ keyMismatch: 'mode TEST avec une clé live (sk_live_…) : appels réels désactivés' });
    await expect(service.initializeTopupPayment('c1', 'TOPUP-1')).rejects.toMatchObject({ status: 503 });
    expect(api.initializeSoftpay).not.toHaveBeenCalled();
  });

  it('REAL + LIVE (sk_live_) = appel SasPay autorisé', async () => {
    const { service, api } = mockDeps({ keyMismatch: null });
    const result = await service.initializeTopupPayment('c1', 'TOPUP-1');
    expect(api.initializeSoftpay).toHaveBeenCalledTimes(1);
    expect(result.saspayEnabled).toBe(true);
  });

  it('REAL + TEST (clé live) = appel réel interdit (503, aucun appel)', async () => {
    const { service, api } = mockDeps({
      keyMismatch: 'mode TEST avec une clé live (sk_live_…) : appels réels désactivés',
    });
    await expect(service.initializeTopupPayment('c1', 'TOPUP-1')).rejects.toMatchObject({ status: 503 });
    expect(api.initializeSoftpay).not.toHaveBeenCalled();
  });

  it('intention autrui → 404', async () => {
    const { service } = mockDeps();
    await expect(service.initializeTopupPayment('c2', 'TOPUP-1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('initializeTopupPayment', () => {
  it('push (pas de checkout_url) → PENDING + pushSent, refs stockées, même clé', async () => {
    const { service, api, prisma, intent } = mockDeps();
    const result = await service.initializeTopupPayment('c1', 'TOPUP-1');
    expect(api.initializeSoftpay).toHaveBeenCalledTimes(1);
    expect(api.initializeSoftpay).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'key-1', amountMinor: 5000, network: 'mtn_cm', country: 'CM' }),
    );
    expect(result).toMatchObject({ saspayEnabled: true, checkoutUrl: null, pushSent: true });
    expect(intent.saspayTransactionId).toBe('pay-1');
    expect(prisma.topupIntent.update).toHaveBeenCalled();
  });

  it('checkout_url → redirect, return_url transmis', async () => {
    const { service, api } = mockDeps({
      initResult: { id: 'pay-2', status: 'PENDING', checkoutUrl: 'https://pay.saspay.me/c/x', message: 'ok' },
    });
    const result = await service.initializeTopupPayment('c1', 'TOPUP-1');
    expect(result.checkoutUrl).toBe('https://pay.saspay.me/c/x');
    expect(result.pushSent).toBe(false);
    expect(api.initializeSoftpay).toHaveBeenCalledWith(
      expect.objectContaining({ returnUrl: expect.stringContaining('/client/solde/recharge/result?intent=TOPUP-1') }),
    );
  });

  it('déjà initialisée → aucun nouvel appel (retry sûr)', async () => {
    const { service, api } = mockDeps({
      intent: {
        id: 'ti-1', reference: 'TOPUP-1', idempotencyKey: 'key-1', userId: 'c1',
        amount: 5000, currency: 'XAF', mode: 'REAL', status: 'PENDING',
        saspayTransactionId: 'pay-1', metadata: {},
      } as never,
    });
    const result = await service.initializeTopupPayment('c1', 'TOPUP-1');
    expect(api.initializeSoftpay).not.toHaveBeenCalled();
    expect(result.saspayTransactionId).toBe('pay-1');
  });

  it('erreur terminale 422 → FAILED + 502, aucun crédit', async () => {
    const { service, api, financial } = mockDeps({
      initError: new SasPayTerminalException('Réseau inconnu.', 'invalid_method', 422),
    });
    await expect(service.initializeTopupPayment('c1', 'TOPUP-1')).rejects.toMatchObject({ status: 502 });
    expect(financial.failTopupIntent).toHaveBeenCalledTimes(1);
    expect(api.initializeSoftpay).toHaveBeenCalledTimes(1);
  });

  it('coupure réseau → PENDING conservé + 502 (retry même clé)', async () => {
    const { service, financial, intent } = mockDeps({ initError: new SasPayUpstreamException('timeout') });
    await expect(service.initializeTopupPayment('c1', 'TOPUP-1')).rejects.toMatchObject({ status: 502 });
    expect(financial.failTopupIntent).not.toHaveBeenCalled();
    expect(intent.status).toBe('PENDING');
  });
});

describe('verifyTopupPayment (sans polling)', () => {
  const initializedIntent = {
    id: 'ti-1', reference: 'TOPUP-1', idempotencyKey: 'key-1', userId: 'c1',
    amount: 5000, currency: 'XAF', mode: 'REAL', status: 'PENDING',
    saspayTransactionId: 'pay-1', saspayReference: null, externalReference: null,
    network: 'mtn_cm', country: 'CM', fee: null, chargedAmount: null, netAmount: null,
    creditedTransactionId: null, metadata: {},
  } as never;

  it('SUCCESS vérifié → crédit unique via confirmTopupFromSasPay', async () => {
    const { service, financial } = mockDeps({
      intent: initializedIntent,
      verifyResult: {
        id: 'pay-1', reference: 'TXN-1', externalReference: null, status: 'SUCCESS',
        requestedAmountMinor: 5000, netAmountMinor: 5000, chargedAmountMinor: 5000,
        feeMinor: 0, feeChargeMode: 'ADD_ON', currency: 'XAF', country: 'CM', network: 'mtn_cm',
      },
    });
    const result = await service.verifyTopupPayment('c1', 'TOPUP-1');
    expect(financial.confirmTopupFromSasPay).toHaveBeenCalledWith(
      expect.objectContaining({ intentReference: 'TOPUP-1', currency: 'XAF', netAmountMinor: 5000 }),
    );
    expect(result.saspayStatus).toBe('SUCCESS');
  });

  it('FAILED vérifié → FAILED, aucun crédit', async () => {
    const { service, financial } = mockDeps({
      intent: initializedIntent,
      verifyResult: { id: 'pay-1', status: 'FAILED', currency: 'XAF' },
    });
    const result = await service.verifyTopupPayment('c1', 'TOPUP-1');
    expect(financial.failTopupIntent).toHaveBeenCalledTimes(1);
    expect(financial.confirmTopupFromSasPay).not.toHaveBeenCalled();
    expect(result.saspayStatus).toBe('FAILED');
  });

  it('404 SasPay → PENDING conservé, on n\'invente rien', async () => {
    const { service, financial } = mockDeps({ intent: initializedIntent, verifyResult: null });
    const result = await service.verifyTopupPayment('c1', 'TOPUP-1');
    expect(result.saspayStatus).toBe('UNKNOWN');
    expect(financial.failTopupIntent).not.toHaveBeenCalled();
    expect(financial.confirmTopupFromSasPay).not.toHaveBeenCalled();
  });

  it('sans transaction SasPay → aucun appel verify', async () => {
    const { service, api } = mockDeps();
    const result = await service.verifyTopupPayment('c1', 'TOPUP-1');
    expect(api.verifyPayment).not.toHaveBeenCalled();
    expect(result.saspayStatus).toBeNull();
  });
});
