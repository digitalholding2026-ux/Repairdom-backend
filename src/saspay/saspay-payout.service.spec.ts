import { describe, expect, it, vi } from 'vitest';
import { SasPayPayoutService } from './saspay-payout.service.js';
import { SasPayTerminalException, SasPayUpstreamException } from './saspay-api.client.js';

/* Sprint PAYOUT — orchestration init/verify (dépendances mockées) : gates
 * REAL/config/clé, init idempotente même clé, erreurs terminales vs
 * rejouables (ip_not_whitelisted explicite), vérification sans polling.
 * Aucun appel réseau réel. */

type Row = Record<string, any>;

function mockDeps(overrides: {
  financialMode?: string;
  configured?: boolean;
  keyMismatch?: string | null;
  request?: Row | null;
  initResult?: unknown;
  initError?: unknown;
  verifyResult?: unknown;
  verifyError?: unknown;
} = {}) {
  const request: Row =
    overrides.request ?? {
      id: 'wr-1',
      reference: 'WD-1',
      idempotencyKey: 'wkey-1',
      userId: 'c1',
      amount: 10000,
      currency: 'XAF',
      mode: 'REAL',
      status: 'PENDING',
      holdId: 'hold-1',
      saspayTransactionId: null,
      saspayReference: null,
      externalReference: null,
      network: 'mtn_cm',
      country: 'CM',
      fee: null,
      chargedAmount: null,
      netAmount: null,
      metadata: { msisdn: '+237677889900' },
    };
  const prisma = {
    withdrawalRequest: {
      findUnique: vi.fn(async () => (overrides.request === null ? null : { ...request, user: { id: 'c1', firstName: 'Awa', lastName: 'S', email: 'c@example.com', role: 'CLIENT' } })),
      update: vi.fn(async ({ data }: any) => Object.assign(request, data)),
    },
  };
  const financial = {
    getMode: vi.fn(() => overrides.financialMode ?? 'REAL'),
    getWithdrawalRequestForOwner: vi.fn(async () => ({ reference: request.reference, status: request.status })),
    settleWithdrawalSuccess: vi.fn(async () => ({ request: { reference: request.reference, status: 'SUCCESS' }, debited: true })),
    settleWithdrawalFailure: vi.fn(async () => ({ reference: request.reference, status: 'FAILED' })),
  };
  const api = {
    initializePayout: overrides.initError
      ? vi.fn(async () => { throw overrides.initError; })
      : vi.fn(async () => overrides.initResult ?? { id: 'po-1', message: 'ok' }),
    verifyPayout: overrides.verifyError
      ? vi.fn(async () => { throw overrides.verifyError; })
      : vi.fn(async () => overrides.verifyResult ?? null),
  };
  const saspayConfig = {
    isConfigured: vi.fn(() => overrides.configured ?? true),
    keyModeMismatch: vi.fn(() => overrides.keyMismatch ?? null),
  };
  const config = { get: vi.fn(() => undefined) };
  const service = new SasPayPayoutService(prisma as never, financial as never, api as never, saspayConfig as never, config as never);
  return { service, prisma, financial, api, request };
}

describe('gates : SIMULATION / config / clé / propriété', () => {
  it('SIMULATION → 403, aucun appel SasPay', async () => {
    const { service, api } = mockDeps({ financialMode: 'SIMULATION' });
    await expect(service.initializeWithdrawalPayout('c1', 'WD-1')).rejects.toMatchObject({ status: 403 });
    expect(api.initializePayout).not.toHaveBeenCalled();
  });

  it('config incomplète → 503, aucun appel', async () => {
    const { service, api } = mockDeps({ configured: false });
    await expect(service.initializeWithdrawalPayout('c1', 'WD-1')).rejects.toMatchObject({ status: 503 });
    expect(api.initializePayout).not.toHaveBeenCalled();
  });

  it("demande d'autrui → 404", async () => {
    const { service, api } = mockDeps();
    await expect(service.initializeWithdrawalPayout('c2', 'WD-1')).rejects.toMatchObject({ status: 404 });
    expect(api.initializePayout).not.toHaveBeenCalled();
  });
});

describe('initializeWithdrawalPayout', () => {
  it('init → id stocké, même Idempotency-Key, payload CM/XAF/method/msisdn', async () => {
    const { service, api, prisma, request } = mockDeps();
    const result = await service.initializeWithdrawalPayout('c1', 'WD-1');
    expect(api.initializePayout).toHaveBeenCalledTimes(1);
    expect(api.initializePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        amountMinor: 10000,
        currency: 'XAF',
        country: 'CM',
        method: 'mtn_cm',
        recipient: { msisdn: '+237677889900' },
        idempotencyKey: 'wkey-1',
      }),
    );
    expect(request.saspayTransactionId).toBe('po-1');
    expect(result.saspayTransactionId).toBe('po-1');
    expect(result.paymentError).toBeNull();
    expect(prisma.withdrawalRequest.update).toHaveBeenCalled();
  });

  it('déjà initialisée → aucun nouvel appel (retry sûr, pas de 2e payout)', async () => {
    const { service, api } = mockDeps({
      request: {
        id: 'wr-1', reference: 'WD-1', idempotencyKey: 'wkey-1', userId: 'c1',
        amount: 10000, currency: 'XAF', mode: 'REAL', status: 'PENDING',
        saspayTransactionId: 'po-1', metadata: {},
      } as never,
    });
    const result = await service.initializeWithdrawalPayout('c1', 'WD-1');
    expect(api.initializePayout).not.toHaveBeenCalled();
    expect(result.saspayTransactionId).toBe('po-1');
  });

  it('403 ip_not_whitelisted → FAILED + paymentError explicite, aucun débit', async () => {
    const { service, api, financial } = mockDeps({
      initError: new SasPayTerminalException('IP non autorisée pour les payouts.', 'ip_not_whitelisted', 403),
    });
    const result = await service.initializeWithdrawalPayout('c1', 'WD-1');
    expect(financial.settleWithdrawalFailure).toHaveBeenCalledTimes(1);
    expect(result.paymentError).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(result.request?.status).toBe('FAILED');
    expect(api.initializePayout).toHaveBeenCalledTimes(1);
  });

  it('422 invalid_method → FAILED + VALIDATION_ERROR', async () => {
    const { service, financial } = mockDeps({
      initError: new SasPayTerminalException('Réseau inactif.', 'invalid_method', 422),
    });
    const result = await service.initializeWithdrawalPayout('c1', 'WD-1');
    expect(financial.settleWithdrawalFailure).toHaveBeenCalledTimes(1);
    expect(result.paymentError).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('timeout → PENDING conservé + 503, même clé au retry, aucun FAILED', async () => {
    const { service, api, financial, request } = mockDeps({
      initError: new SasPayUpstreamException('timeout'),
    });
    const error = await service.initializeWithdrawalPayout('c1', 'WD-1').catch((e) => e);
    expect(error.status).toBe(503);
    expect(error.response).toMatchObject({ code: 'COMMUNICATION_ERROR' });
    expect(financial.settleWithdrawalFailure).not.toHaveBeenCalled();
    expect(request.status).toBe('PENDING');
    expect(request.saspayTransactionId).toBeNull();
    expect(api.initializePayout).toHaveBeenCalledTimes(1);
  });

  it('réseau non supporté → 409, aucun appel', async () => {
    const { service, api } = mockDeps({
      request: {
        id: 'wr-1', reference: 'WD-1', idempotencyKey: 'wkey-1', userId: 'c1',
        amount: 10000, currency: 'XAF', mode: 'REAL', status: 'PENDING',
        network: 'eu_mobile_cm', metadata: { msisdn: '+237677889900' },
      } as never,
    });
    await expect(service.initializeWithdrawalPayout('c1', 'WD-1')).rejects.toMatchObject({ status: 409 });
    expect(api.initializePayout).not.toHaveBeenCalled();
  });
});

describe('verifyWithdrawalPayout (sans polling)', () => {
  const initialized = {
    id: 'wr-1', reference: 'WD-1', idempotencyKey: 'wkey-1', userId: 'c1',
    amount: 10000, currency: 'XAF', mode: 'REAL', status: 'PENDING',
    saspayTransactionId: 'po-1', saspayReference: null, externalReference: null,
    network: 'mtn_cm', country: 'CM', fee: null, chargedAmount: null, netAmount: null,
    metadata: {},
  } as never;

  it('SUCCESS vérifié → settle au charged/net constatés (pas au requested seul)', async () => {
    const { service, financial } = mockDeps({
      request: initialized,
      verifyResult: {
        id: 'po-1', reference: 'TXN-W1', externalReference: null, status: 'SUCCESS',
        requestedAmountMinor: 10000, netAmountMinor: 9850, chargedAmountMinor: 10000,
        feeMinor: 150, feeChargeMode: 'DEDUCTED', currency: 'XAF', country: null, network: null,
        transactionType: 'RETRAIT', flowDirection: 'OUTBOUND',
      },
    });
    // settle réel via financial mocké : on vérifie le mapping transmis.
    const result = await service.verifyWithdrawalPayout('c1', 'WD-1');
    expect(financial.settleWithdrawalSuccess).toHaveBeenCalledWith(
      'WD-1',
      expect.objectContaining({ saspayTransactionId: 'po-1', chargedAmount: 10000, netAmount: 9850, fee: 150 }),
    );
    expect(result.saspayStatus).toBe('SUCCESS');
  });

  it('FAILED vérifié → FAILED + hold libéré (via settle), aucun débit', async () => {
    const { service, financial } = mockDeps({
      request: initialized,
      verifyResult: { id: 'po-1', status: 'FAILED', currency: 'XAF' },
    });
    const result = await service.verifyWithdrawalPayout('c1', 'WD-1');
    expect(financial.settleWithdrawalFailure).toHaveBeenCalledWith('WD-1', 'FAILED', expect.any(String));
    expect(financial.settleWithdrawalSuccess).not.toHaveBeenCalled();
    expect(result.saspayStatus).toBe('FAILED');
  });

  it('PENDING → attente, montants connus enregistrés, aucun règlement', async () => {
    const { service, financial } = mockDeps({
      request: initialized,
      verifyResult: { id: 'po-1', status: 'PENDING', currency: 'XAF', requestedAmountMinor: 10000, feeMinor: 150 },
    });
    const result = await service.verifyWithdrawalPayout('c1', 'WD-1');
    expect(result.saspayStatus).toBe('PENDING');
    expect(financial.settleWithdrawalSuccess).not.toHaveBeenCalled();
    expect(financial.settleWithdrawalFailure).not.toHaveBeenCalled();
  });

  it('timeout verify → UNKNOWN + COMMUNICATION_ERROR, sans throw', async () => {
    const { service, financial } = mockDeps({
      request: initialized,
      verifyError: new SasPayUpstreamException('timeout'),
    });
    const result = await service.verifyWithdrawalPayout('c1', 'WD-1');
    expect(result.saspayStatus).toBe('UNKNOWN');
    expect(result.verificationError).toMatchObject({ code: 'COMMUNICATION_ERROR' });
    expect(financial.settleWithdrawalFailure).not.toHaveBeenCalled();
  });
});
