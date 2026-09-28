import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SasPayWebhookController } from './saspay-webhook.controller.js';
import { SasPayWebhookService } from './saspay-webhook.service.js';

/* CHANTIER ERREURS P1 — classification webhook : body malformé → 400
 * (plus de 401 trompeur), HMAC inchangée et préalable. Aucun appel réel. */

const SECRET = 'whsec_test_erreurs';

function service() {
  const config = {
    webhookSecret: SECRET,
    baseUrl: 'https://api.saspay.me/api/v1',
    mode: 'TEST' as const,
    isConfigured: () => true,
  };
  const financial = {
    confirmTopupFromSasPay: vi.fn(async () => ({ credited: true })),
    failTopupFromSasPay: vi.fn(async () => ({ status: 'FAILED' })),
    cancelTopupFromSasPay: vi.fn(async () => ({ status: 'CANCELLED' })),
    findWithdrawalReferenceBySasPay: vi.fn(async (): Promise<string | null> => null),
    settleWithdrawalSuccess: vi.fn(async () => ({ debited: true })),
    settleWithdrawalFailure: vi.fn(async () => ({ status: 'FAILED' })),
  };
  return new SasPayWebhookService(config as never, financial as never);
}

function sign(raw: string, timestamp: string): string {
  return createHmac('sha256', SECRET).update(`${timestamp}.${raw}`).digest('hex');
}

function req(raw: string) {
  return { rawBody: Buffer.from(raw, 'utf8') } as never;
}

describe('webhook : classification HTTP', () => {
  it('body non-JSON (signature valide) → 400, HMAC toujours vérifiée avant', async () => {
    const controller = new SasPayWebhookController(service());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const raw = 'ceci-n-est-pas-du-json{{{';
    const error = await controller
      .handle(req(raw), sign(raw, timestamp), timestamp, 'transaction.success')
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ status: 400 });
  });

  it('signature absente → 401 (inchangé)', async () => {
    const controller = new SasPayWebhookController(service());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const error = await controller
      .handle(req('{"event":"x"}'), undefined, timestamp, 'transaction.success')
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ status: 401 });
  });

  it('signature invalide → 401 (inchangé)', async () => {
    const controller = new SasPayWebhookController(service());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const error = await controller
      .handle(req('{"event":"x"}'), 'deadbeef'.repeat(8), timestamp, 'transaction.success')
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ status: 401 });
  });

  it('timestamp expiré → 401 (inchangé)', async () => {
    const controller = new SasPayWebhookController(service());
    const stale = String(Math.floor(Date.now() / 1000) - 600);
    const raw = '{"event":"x"}';
    const error = await controller
      .handle(req(raw), sign(raw, stale), stale, 'transaction.success')
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ status: 401 });
  });

  it('JSON valide + signature valide → 200 (régression)', async () => {
    const controller = new SasPayWebhookController(service());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const raw = '{"event":"unknown.test.event"}';
    const result = await controller.handle(
      req(raw),
      sign(raw, timestamp),
      timestamp,
      'unknown.test.event',
    );
    expect(result).toMatchObject({ received: true });
  });
});
