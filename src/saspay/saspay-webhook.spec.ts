import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { SasPayWebhookService } from './saspay-webhook.service.js';

const SECRET = 'whsec_test_fondation';

/* Sprint SASPAY-01 — webhooks SasPay : signature HMAC, fenêtre timestamp,
 * comparaison constante, dispatch idempotent, settlement.* ignorés. */

function webhookService(financial: unknown) {
  const config = {
    webhookSecret: SECRET,
    baseUrl: 'https://api.saspay.me/api/v1',
    mode: 'TEST' as const,
    isConfigured: () => true,
  };
  return new SasPayWebhookService(
    config as never,
    financial as never,
  );
}

function sign(rawBody: string, timestamp: string): string {
  return createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
}

describe('webhook SasPay : vérification HMAC', () => {
  it('signature valide → acceptée', () => {
    const service = webhookService({});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const raw = '{"event":"transaction.success"}';
    expect(() =>
      service.verifySignature(raw, timestamp, sign(raw, timestamp)),
    ).not.toThrow();
  });

  it('mauvaise signature → 401', () => {
    const service = webhookService({});
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(() =>
      service.verifySignature('{"event":"x"}', timestamp, 'deadbeef'.repeat(8)),
    ).toThrowError(expect.objectContaining({ status: 401 }));
  });

  it('timestamp expiré (> 5 min) → 401', () => {
    const service = webhookService({});
    const stale = String(Math.floor(Date.now() / 1000) - 301);
    const raw = '{"event":"transaction.success"}';
    expect(() => service.verifySignature(raw, stale, sign(raw, stale))).toThrowError(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('signature manquante → 401', () => {
    const service = webhookService({});
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(() => service.verifySignature('{}', timestamp, '')).toThrowError(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('secret non configuré → 401', () => {
    const config = { webhookSecret: null };
    const service = new SasPayWebhookService(config as never, {} as never);
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(() => service.verifySignature('{}', timestamp, 'abc')).toThrowError(
      expect.objectContaining({ status: 401 }),
    );
  });
});

describe('webhook SasPay : dispatch idempotent', () => {
  const mockFinancial = () => ({
    confirmTopupFromSasPay: vi.fn(async () => ({ credited: true })),
    failTopupFromSasPay: vi.fn(async () => ({ status: 'FAILED' })),
    cancelTopupFromSasPay: vi.fn(async () => ({ status: 'CANCELLED' })),
    confirmTopupIntent: vi.fn(),
    failTopupIntent: vi.fn(),
    findWithdrawalReferenceBySasPay: vi.fn(async (): Promise<string | null> => null),
    settleWithdrawalSuccess: vi.fn(async () => ({ debited: true })),
    failWithdrawalFromSasPay: vi.fn(async () => ({ status: 'FAILED' })),
    cancelWithdrawalFromSasPay: vi.fn(async () => ({ status: 'CANCELLED' })),
  });

  it('transaction.success → confirmTopupFromSasPay (rejoué : aucun second crédit côté moteur)', async () => {
    const financial = mockFinancial();
    const service = webhookService(financial);
    // Payload doc : décimaux en string, net = 5000.00 pour 5000 demandés.
    const data = {
      id: 'sp-1',
      reference: 'TXN-1',
      amount: '5000.00',
      fee: '0.00',
      charged: '5000.00',
      net_amount: '5000.00',
      fee_charge_mode: 'ADD_ON',
      currency: 'XAF',
      country: 'CM',
      network: 'mtn_cm',
      internalReference: 'TOPUP-ABC',
    };
    const first = await service.handleEvent('transaction.success', data);
    const second = await service.handleEvent('transaction.success', data);
    expect(first).toMatchObject({ handled: true, credited: true });
    expect(second).toMatchObject({ handled: true });
    expect(financial.confirmTopupFromSasPay).toHaveBeenCalledTimes(2);
    // L'idempotence réelle (aucun second crédit) est garantie par
    // confirmTopupFromSasPay (reference UNIQUE + SUCCESS terminal) — le
    // webhook rejoue l'appel sans crainte de double écriture.
    expect(financial.confirmTopupFromSasPay).toHaveBeenCalledWith(
      expect.objectContaining({
        intentReference: 'TOPUP-ABC',
        saspayTransactionId: 'sp-1',
        currency: 'XAF',
        requestedAmountMinor: 5000,
        netAmountMinor: 5000,
      }),
    );
  });

  it('transaction.success refusé par le moteur (devise) → accusé sans crédit', async () => {
    const financial = mockFinancial();
    financial.confirmTopupFromSasPay.mockRejectedValueOnce(
      Object.assign(new Error('DEVISE_INATTENDUE — devise XOF'), { status: 409 }),
    );
    const service = webhookService(financial);
    const result = await service.handleEvent('transaction.success', {
      id: 'sp-9',
      amount: '5000.00',
      net_amount: '5000.00',
      currency: 'XOF',
      internalReference: 'TOPUP-ABC',
    });
    expect(result).toMatchObject({ handled: false, reason: 'rejected' });
  });

  it('transaction.failed → failTopupFromSasPay, aucun crédit', async () => {
    const financial = mockFinancial();
    const service = webhookService(financial);
    const result = await service.handleEvent('transaction.failed', {
      id: 'sp-2',
      internalReference: 'TOPUP-ABC',
      reason: 'fonds insuffisants',
    });
    expect(result).toMatchObject({ handled: true, event: 'transaction.failed' });
    expect(financial.failTopupFromSasPay).toHaveBeenCalledWith(
      expect.objectContaining({ intentReference: 'TOPUP-ABC', saspayTransactionId: 'sp-2' }),
    );
    expect(financial.confirmTopupFromSasPay).not.toHaveBeenCalled();
  });

  it('transaction.failed répété → idempotent (moteur)', async () => {
    const financial = mockFinancial();
    const service = webhookService(financial);
    await service.handleEvent('transaction.failed', { id: 'sp-2', internalReference: 'TOPUP-A' });
    await service.handleEvent('transaction.failed', { id: 'sp-2', internalReference: 'TOPUP-A' });
    expect(financial.failTopupFromSasPay).toHaveBeenCalledTimes(2);
  });

  it('transaction.cancelled → cancelTopupFromSasPay', async () => {
    const financial = mockFinancial();
    const service = webhookService(financial);
    const result = await service.handleEvent('transaction.cancelled', {
      id: 'sp-3',
      internalReference: 'TOPUP-ABC',
    });
    expect(result).toMatchObject({ handled: true, event: 'transaction.cancelled' });
    expect(financial.cancelTopupFromSasPay).toHaveBeenCalledTimes(1);
  });

  it('transaction inconnue → accusé sans effet (pas de 500 → pas de retry infini)', async () => {
    const financial = mockFinancial();
    financial.failTopupFromSasPay.mockRejectedValueOnce(new Error('Transaction SasPay inconnue'));
    const service = webhookService(financial);
    const result = await service.handleEvent('transaction.failed', { id: 'sp-zzz' });
    expect(result).toMatchObject({ handled: false, reason: 'unknown-transaction' });
  });

  it('settlement.* → ignoré sans effet ledger (structure instable)', async () => {
    const financial = { confirmTopupIntent: vi.fn(), failTopupIntent: vi.fn() };
    const service = webhookService(financial);
    const result = await service.handleEvent('settlement.completed', { amount: 999 });
    expect(result).toMatchObject({ handled: false, reason: 'settlement-ignored' });
    expect(financial.confirmTopupIntent).not.toHaveBeenCalled();
    expect(financial.failTopupIntent).not.toHaveBeenCalled();
  });

  it('événement inconnu → ignoré sans effet', async () => {
    const financial = { confirmTopupIntent: vi.fn(), failTopupIntent: vi.fn() };
    const service = webhookService(financial);
    const result = await service.handleEvent('mystery.event', {});
    expect(result).toMatchObject({ handled: false, reason: 'unknown-event' });
  });

  it('sans référence interne → ignoré sans effet', async () => {
    const financial = { confirmTopupIntent: vi.fn(), failTopupIntent: vi.fn() };
    const service = webhookService(financial);
    const result = await service.handleEvent('transaction.success', { amount: 100 });
    expect(result).toMatchObject({ handled: false, reason: 'missing-reference' });
    expect(financial.confirmTopupIntent).not.toHaveBeenCalled();
  });
});

describe('webhook SasPay : routage payout', () => {
  const mockFinancial = () => ({
    confirmTopupFromSasPay: vi.fn(),
    failTopupFromSasPay: vi.fn(),
    cancelTopupFromSasPay: vi.fn(),
    findWithdrawalReferenceBySasPay: vi.fn(async (): Promise<string | null> => null),
    settleWithdrawalSuccess: vi.fn(async () => ({ debited: true })),
    failWithdrawalFromSasPay: vi.fn(async () => ({ status: 'FAILED' })),
    cancelWithdrawalFromSasPay: vi.fn(async () => ({ status: 'CANCELLED' })),
  });

  const payoutData = {
    id: 'po-1',
    reference: 'TXN-W1',
    type: 'RETRAIT',
    status: 'SUCCESS',
    amount: '10000.00',
    fee: '150.00',
    charged: '10000.00',
    net_amount: '9850.00',
    fee_charge_mode: 'DEDUCTED',
    currency: 'XAF',
    country: 'CM',
    network: 'mtn_cm',
  };

  it('transaction rattachée à un retrait → settleWithdrawalSuccess (débit unique), pas de topup', async () => {
    const financial = mockFinancial();
    financial.findWithdrawalReferenceBySasPay.mockResolvedValue('WD-1');
    const service = webhookService(financial);
    const first = await service.handleEvent('transaction.success', payoutData);
    const second = await service.handleEvent('transaction.success', payoutData);
    expect(first).toMatchObject({ handled: true, debited: true });
    expect(second).toMatchObject({ handled: true });
    expect(financial.settleWithdrawalSuccess).toHaveBeenCalledTimes(2);
    expect(financial.settleWithdrawalSuccess).toHaveBeenCalledWith(
      'WD-1',
      expect.objectContaining({
        saspayTransactionId: 'po-1',
        chargedAmount: 10000,
        netAmount: 9850,
        fee: 150,
      }),
    );
    expect(financial.confirmTopupFromSasPay).not.toHaveBeenCalled();
  });

  it('payout failed → failWithdrawalFromSasPay, aucun débit', async () => {
    const financial = mockFinancial();
    financial.findWithdrawalReferenceBySasPay.mockResolvedValue('WD-1');
    const service = webhookService(financial);
    const result = await service.handleEvent('transaction.failed', { ...payoutData, status: 'FAILED' });
    expect(result).toMatchObject({ handled: true, event: 'transaction.failed' });
    expect(financial.failWithdrawalFromSasPay).toHaveBeenCalledTimes(1);
    expect(financial.settleWithdrawalSuccess).not.toHaveBeenCalled();
    expect(financial.failTopupFromSasPay).not.toHaveBeenCalled();
  });

  it('payout cancelled → cancelWithdrawalFromSasPay', async () => {
    const financial = mockFinancial();
    financial.findWithdrawalReferenceBySasPay.mockResolvedValue('WD-1');
    const service = webhookService(financial);
    const result = await service.handleEvent('transaction.cancelled', { ...payoutData, status: 'CANCELLED' });
    expect(result).toMatchObject({ handled: true, event: 'transaction.cancelled' });
    expect(financial.cancelWithdrawalFromSasPay).toHaveBeenCalledTimes(1);
    expect(financial.settleWithdrawalSuccess).not.toHaveBeenCalled();
  });

  it('transaction non rattachée → flux pay-in conservé', async () => {
    const financial = mockFinancial();
    const service = webhookService(financial);
    await service.handleEvent('transaction.success', { ...payoutData, internalReference: 'TOPUP-X' });
    expect(financial.confirmTopupFromSasPay).toHaveBeenCalledTimes(1);
    expect(financial.settleWithdrawalSuccess).not.toHaveBeenCalled();
  });
});
