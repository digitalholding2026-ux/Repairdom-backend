import { describe, expect, it } from 'vitest';
import { classifyPayoutRejection, payoutUserMessage } from './saspay-errors.js';

/* Sprint PAYOUT — classification des refus d'init payout : transitoire
 * (PENDING conservé) vs définitif/validation (FAILED + texte sûr).
 * Aucun appel réseau. */

describe('classifyPayoutRejection', () => {
  it('5xx / 429 / transitoire → retryable PROVIDER_UNAVAILABLE', () => {
    expect(classifyPayoutRejection(503, null, null).outcome).toBe('retryable');
    expect(classifyPayoutRejection(429, null, null).outcome).toBe('retryable');
    expect(
      classifyPayoutRejection(422, 'no_route_available', 'Service momentanément injoignable.').outcome,
    ).toBe('retryable');
  });

  it('403 ip_not_whitelisted → failed explicite (correction dashboard, pas de retry utile)', () => {
    const result = classifyPayoutRejection(403, 'ip_not_whitelisted', 'IP non autorisée.');
    expect(result.outcome).toBe('failed');
    expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.error.message).toMatch(/configuration/);
  });

  it('422 invalid_method → validation ciblée ; 409 → failed', () => {
    const validation = classifyPayoutRejection(422, 'invalid_method', 'Réseau inactif.');
    expect(validation.outcome).toBe('validation');
    expect(validation.error.code).toBe('VALIDATION_ERROR');
    const conflict = classifyPayoutRejection(409, 'idempotency_conflict', 'Clé déjà utilisée.');
    expect(conflict.outcome).toBe('failed');
  });

  it('refus avec message sûr → repris ; sinon générique, jamais le brut', () => {
    expect(classifyPayoutRejection(400, 'x', 'Fonds insuffisants côté opérateur.').error).toMatchObject({
      code: 'WITHDRAWAL_FAILED',
      message: 'Fonds insuffisants côté opérateur.',
    });
    expect(classifyPayoutRejection(400, 'x', null).error.message).toMatch(/pas abouti/);
  });
});

describe('payoutUserMessage', () => {
  it('SUCCESS / PENDING / CANCELLED → fixes ; FAILED → dérivé', () => {
    expect(payoutUserMessage('SUCCESS', null)).toMatch(/confirmé/);
    expect(payoutUserMessage('PENDING', null)).toMatch(/attente/);
    expect(payoutUserMessage('CANCELLED', null)).toMatch(/annulé/);
    expect(payoutUserMessage('FAILED', 'SASPAY_PAYOUT_INIT invalid_method — x')).toMatch(/réseau/i);
    expect(payoutUserMessage('FAILED', 'SASPAY_PAYOUT_INIT 400 — autre')).toMatch(/pas abouti/);
  });
});
