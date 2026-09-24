import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SasPayApiClient,
  SasPayTerminalException,
  SasPayUpstreamException,
  fromSasPayDecimal,
  toSasPayDecimal,
} from './saspay-api.client.js';

/* Sprint SASPAY-03 — client HTTP SasPay (fetch global stubé) : init
 * softpay (push vs checkout_url), verify, erreurs terminales/rejouables,
 * montants décimaux. Aucun appel réseau réel. */

function client() {
  const config = {
    baseUrl: 'https://api.saspay.me/api/v1',
    mode: 'TEST' as const,
    apiKey: 'sk_test_xxx',
    webhookSecret: 'whsec',
    isConfigured: () => true,
    keyModeMismatch: () => null,
  };
  return new SasPayApiClient(config as never);
}

function stubFetchOnce(status: number, payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status,
      json: async () => payload,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const INIT_INPUT = {
  amountMinor: 5000,
  currency: 'XAF',
  country: 'CM',
  network: 'mtn_cm',
  description: 'Recharge Relio TOPUP-1',
  customer: { email: 'c@example.com', first_name: 'Awa', last_name: 'S', phone: '+237690000000' },
  metadata: { topupIntentReference: 'TOPUP-1' },
  returnUrl: 'https://relio.test/finances/recharge/result?intent=TOPUP-1',
  idempotencyKey: 'key-1',
};

describe('montants décimaux SasPay', () => {
  it('toSasPayDecimal : 5000 → "5000.00"', () => {
    expect(toSasPayDecimal(5000)).toBe('5000.00');
  });

  it('fromSasPayDecimal : "25000.00" → 25000 ; fractions/invalides → null (XAF sans sous-unité)', () => {
    expect(fromSasPayDecimal('25000.00')).toBe(25000);
    expect(fromSasPayDecimal('2500')).toBe(2500);
    expect(fromSasPayDecimal('12.50')).toBeNull();
    expect(fromSasPayDecimal('12.345')).toBeNull();
    expect(fromSasPayDecimal('abc')).toBeNull();
    expect(fromSasPayDecimal('')).toBeNull();
    expect(fromSasPayDecimal(5000)).toBeNull();
    expect(fromSasPayDecimal(null)).toBeNull();
  });
});

describe('initializeSoftpay', () => {
  it('201 push (checkout_url vide) → PENDING, en-têtes Bearer + Idempotency-Key', async () => {
    const seen: { headers: Record<string, string>; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
        return { status: 201, json: async () => ({ message: 'Payment pushed successfully', id: 'pay-1', status: 'PENDING', checkout_url: '' }) };
      }),
    );
    const result = await client().initializeSoftpay(INIT_INPUT);
    expect(result).toMatchObject({ id: 'pay-1', status: 'PENDING', checkoutUrl: null });
    expect(seen[0].headers.Authorization).toBe('Bearer sk_test_xxx');
    expect(seen[0].headers['Idempotency-Key']).toBe('key-1');
    expect(seen[0].body).toMatchObject({
      amount: '5000.00',
      currency: 'XAF',
      country: 'CM',
      network: 'mtn_cm',
    });
  });

  it('réponse enveloppée sous data + checkout_url → redirect', async () => {
    stubFetchOnce(201, {
      data: { id: 'pay-2', status: 'PENDING', checkout_url: 'https://pay.saspay.me/c/abc' },
    });
    const result = await client().initializeSoftpay(INIT_INPUT);
    expect(result.checkoutUrl).toBe('https://pay.saspay.me/c/abc');
  });

  it('409 clé rejouée → terminal ; 422 routage → terminal avec code', async () => {
    stubFetchOnce(409, { message: 'Clé déjà utilisée.', code: 'idempotency_conflict' });
    await expect(client().initializeSoftpay(INIT_INPUT)).rejects.toBeInstanceOf(SasPayTerminalException);
    stubFetchOnce(422, { message: 'Réseau inconnu.', code: 'invalid_method' });
    const err = await client().initializeSoftpay(INIT_INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(SasPayTerminalException);
    expect((err as SasPayTerminalException).code).toBe('invalid_method');
  });

  it('500 → rejouable ; réseau coupé → rejouable', async () => {
    stubFetchOnce(500, { message: 'Erreur interne.' });
    await expect(client().initializeSoftpay(INIT_INPUT)).rejects.toBeInstanceOf(SasPayUpstreamException);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed'); }));
    await expect(client().initializeSoftpay(INIT_INPUT)).rejects.toBeInstanceOf(SasPayUpstreamException);
  });

  it('réponse sans id → rejouable (incomplète)', async () => {
    stubFetchOnce(201, { message: 'ok', status: 'PENDING' });
    await expect(client().initializeSoftpay(INIT_INPUT)).rejects.toBeInstanceOf(SasPayUpstreamException);
  });
});

describe('verifyPayment', () => {  it('200 SUCCESS → montants mappés (net demandé/devise)', async () => {
    stubFetchOnce(200, {
      id: 'pay-1',
      reference: 'TXN-1',
      requested_amount: '5000.00',
      fee_charge_mode: 'ADD_ON',
      client_fee: '0.00',
      debited_amount: '5000.00',
      net_amount: '5000.00',
      currency: 'XAF',
      status: 'SUCCESS',
      external_reference: 'PWP-1',
    });
    const verified = await client().verifyPayment('pay-1');
    expect(verified).toMatchObject({
      id: 'pay-1',
      reference: 'TXN-1',
      status: 'SUCCESS',
      requestedAmountMinor: 5000,
      netAmountMinor: 5000,
      chargedAmountMinor: 5000,
      currency: 'XAF',
    });
  });

  it('404 → null (on n\'invente aucun échec)', async () => {
    stubFetchOnce(404, { message: 'Transaction introuvable.', code: 'not_found' });
    expect(await client().verifyPayment('pay-zzz')).toBeNull();
  });

  it('500 → rejouable', async () => {
    stubFetchOnce(500, { message: 'Erreur.' });
    await expect(client().verifyPayment('pay-1')).rejects.toBeInstanceOf(SasPayUpstreamException);
  });
});

describe('initializePayout', () => {
  const PAYOUT_INPUT = {
    amountMinor: 10000,
    currency: 'XAF',
    country: 'CM',
    method: 'mtn_cm',
    description: 'Retrait Relio WD-1',
    customer: { email: 'c@example.com', first_name: 'Awa', last_name: 'S', phone: '+237677889900' },
    recipient: { msisdn: '677889900' },
    metadata: { withdrawalRequestReference: 'WD-1' },
    idempotencyKey: 'wkey-1',
  };

  it('201 → id renvoyé, payload CM/XAF/method/msisdn, clé portée', async () => {
    const seen: { headers: Record<string, string>; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
        return { status: 201, json: async () => ({ message: 'Payout transaction initialized successfully', id: 'po-1' }) };
      }),
    );
    const result = await client().initializePayout(PAYOUT_INPUT);
    expect(result).toMatchObject({ id: 'po-1' });
    expect(seen[0].headers['Idempotency-Key']).toBe('wkey-1');
    expect(seen[0].body).toMatchObject({
      amount: '10000.00',
      currency: 'XAF',
      country: 'CM',
      method: 'mtn_cm',
      recipient: { msisdn: '677889900' },
    });
  });

  it('403 ip_not_whitelisted → terminal avec code conservé (erreur explicite côté service)', async () => {
    stubFetchOnce(403, { message: 'IP non autorisée pour les payouts.', code: 'ip_not_whitelisted' });
    const err = await client().initializePayout(PAYOUT_INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(SasPayTerminalException);
    expect((err as SasPayTerminalException).code).toBe('ip_not_whitelisted');
  });

  it('422 routage → terminal ; 500/timeout → rejouable', async () => {
    stubFetchOnce(422, { message: 'La devise XOF ne correspond pas au pays CM.', code: 'currency_country_mismatch' });
    await expect(client().initializePayout(PAYOUT_INPUT)).rejects.toBeInstanceOf(SasPayTerminalException);
    stubFetchOnce(500, { message: 'Erreur.' });
    await expect(client().initializePayout(PAYOUT_INPUT)).rejects.toBeInstanceOf(SasPayUpstreamException);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed'); }));
    await expect(client().initializePayout(PAYOUT_INPUT)).rejects.toBeInstanceOf(SasPayUpstreamException);
  });
});

describe('verifyPayout', () => {
  it('200 SUCCESS (RETRAIT/OUTBOUND) → montants mappés', async () => {
    stubFetchOnce(200, {
      id: 'po-1',
      reference: 'TXN-W1',
      transaction_type: 'RETRAIT',
      flow_direction: 'OUTBOUND',
      requested_amount: '10000.00',
      fee_charge_mode: 'DEDUCTED',
      client_fee: '150.00',
      debited_amount: '10000.00',
      net_amount: '9850.00',
      currency: 'XAF',
      status: 'SUCCESS',
    });
    const verified = await client().verifyPayout('po-1');
    expect(verified).toMatchObject({
      id: 'po-1',
      status: 'SUCCESS',
      requestedAmountMinor: 10000,
      chargedAmountMinor: 10000,
      netAmountMinor: 9850,
      feeMinor: 150,
      transactionType: 'RETRAIT',
      flowDirection: 'OUTBOUND',
    });
  });

  it('404 → null ; 500 → rejouable', async () => {
    stubFetchOnce(404, { message: 'Transaction introuvable.', code: 'not_found' });
    expect(await client().verifyPayout('po-zzz')).toBeNull();
    stubFetchOnce(500, { message: 'Erreur.' });
    await expect(client().verifyPayout('po-1')).rejects.toBeInstanceOf(SasPayUpstreamException);
  });
});
