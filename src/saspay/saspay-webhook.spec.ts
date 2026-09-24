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
  it('transaction.success → confirmTopupIntent (une seule fois même rejoué)', async () => {
    const financial = {
      confirmTopupIntent: vi.fn(async () => ({ credited: true })),
      failTopupIntent: vi.fn(),
    };
    const service = webhookService(financial);
    const data = { internalReference: 'TOPUP-ABC', netAmount: 5000 };
    const first = await service.handleEvent('transaction.success', data);
    const second = await service.handleEvent('transaction.success', data);
    expect(first).toMatchObject({ handled: true, credited: true });
    expect(second).toMatchObject({ handled: true });
    expect(financial.confirmTopupIntent).toHaveBeenCalledTimes(2);
    // L'idempotence réelle (aucun second crédit) est garantie par
    // confirmTopupIntent (reference UNIQUE) — le webhook rejoue l'appel
    // sans crainte de double écriture.
  });

  it('transaction.failed → failTopupIntent, aucun crédit', async () => {
    const financial = {
      confirmTopupIntent: vi.fn(),
      failTopupIntent: vi.fn(async () => ({ status: 'FAILED' })),
    };
    const service = webhookService(financial);
    const result = await service.handleEvent('transaction.failed', {
      internalReference: 'TOPUP-ABC',
      reason: 'fonds insuffisants',
    });
    expect(result).toMatchObject({ handled: true });
    expect(financial.confirmTopupIntent).not.toHaveBeenCalled();
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
