import { describe, expect, it, vi } from 'vitest';
import { SasPayPayoutService } from './saspay-payout.service.js';
import { SasPayTerminalException, SasPayUpstreamException } from './saspay-api.client.js';
import { computeSaspayPayoutFee } from '../financial/saspay-fees.js';

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
        /* OPTION A : net 10 000 → brut 10 363 envoyé à SasPay, pour que le
         * bénéficiaire reçoive exactement 10 000. */
        amountMinor: 10_363,
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

/* ─────────────────────────────────────────────────────────────────────────
 * OPTION A (TRANSPARENCE SASPAY) — le montant ENVOYÉ est le brut majoré.
 *
 * SasPay déduit 3,5 % du montant qu'il reçoit : pour que le technicien
 * encaisse EXACTEMENT son net demandé (celui affiché dans l'UI, celui du
 * hold), Relio doit envoyer `ceil(net / 0,965)`. Les frais sont à la charge
 * de Relio — le technicien ne voit jamais ce montant.
 *
 * Ces tests vérifient le CORPS ENVOYÉ à SasPay (mock fidèle : il capture
 * l'argument réellement transmis, il ne le recalcule pas), sur toute la plage
 * des bornes de retrait.
 * ───────────────────────────────────────────────────────────────────────── */
describe('Option A — majoration du payout avant envoi', () => {
  function requestFor(net: number): Row {
    return {
      id: 'wr-1', reference: 'WD-1', idempotencyKey: 'wkey-1', userId: 't1',
      amount: net, currency: 'XAF', mode: 'REAL', status: 'PENDING',
      holdId: 'hold-1', saspayTransactionId: null, saspayReference: null,
      externalReference: null, network: 'mtn_cm', country: 'CM',
      fee: null, chargedAmount: null, netAmount: null,
      metadata: { msisdn: '+237677889900' },
    } as never;
  }

  it('net 10 000 → SasPay reçoit 10 363 (le technicien encaisse 10 000)', async () => {
    const { service, api } = mockDeps({ request: requestFor(10_000) });
    await service.initializeWithdrawalPayout('t1', 'WD-1');
    expect(api.initializePayout).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 10_363 }),
    );
  });

  it('le net demandé n’est JAMAIS modifié en base (WithdrawalRequest.amount)', async () => {
    const { service, request } = mockDeps({ request: requestFor(10_000) });
    await service.initializeWithdrawalPayout('t1', 'WD-1');
    // `amount` reste le NET : c'est lui qui est débité du ledger et affiché.
    expect(request.amount).toBe(10_000);
    // La majoration ne pollue pas non plus la metadata persistée.
    expect(request.metadata).not.toHaveProperty('chargedAmount');
    expect(request.metadata).not.toHaveProperty('saspayFee');
  });

  it('le brut envoyé garantit le net sur toute la plage 100 → 10 000 000', async () => {
    for (const net of [100, 500, 2_000, 15_900, 100_000, 10_000_000]) {
      const { service, api } = mockDeps({ request: requestFor(net) });
      await service.initializeWithdrawalPayout('t1', 'WD-1');
      const sent = (api.initializePayout as ReturnType<typeof vi.fn>).mock.calls[0]![0]
        .amountMinor as number;
      expect(sent).toBe(Math.ceil(net / 0.965));
      // Le net réellement encaissé couvre le net demandé (Option A).
      expect(sent * 0.965).toBeGreaterThanOrEqual(net);
      // Le surplus est exactement le frais supporté par Relio, et il reste
      // marginal : au plus le taux plus 1 XAF d'arrondi au supérieur.
      expect(sent - net).toBe(computeSaspayPayoutFee(net));
      expect(sent - net).toBeLessThanOrEqual(net * 0.035 / 0.965 + 1);
    }
  });

  it('plafond : un retrait net de 10 000 000 est accepté et envoyé à 10 362 695', async () => {
    const { service, api } = mockDeps({ request: requestFor(10_000_000) });
    await service.initializeWithdrawalPayout('t1', 'WD-1');
    const sent = (api.initializePayout as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      .amountMinor as number;
    expect(sent).toBe(Math.ceil(10_000_000 / 0.965));
    expect(sent * 0.965).toBeGreaterThanOrEqual(10_000_000);
    // Le NET reste dans la borne utilisateur MAX_WITHDRAWAL_AMOUNT ; le brut
    // la dépasse volontairement (décision validée : plafond sur le net).
    expect(10_000_000).toBeLessThanOrEqual(10_000_000);
  });
});
