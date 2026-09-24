import { describe, expect, it } from 'vitest';
import {
  classifyInitRejection,
  isSafeUserMessage,
  topupUserMessage,
} from './saspay-errors.js';

/* Gestion des erreurs pay-in : l'indisponibilité transitoire (Orange
 * « momentanément injoignable ») ne devient jamais un FAILED ; les refus
 * renvoient un texte sûr, jamais le payload brut. Aucun appel réseau. */

describe('transitoire vs définitif', () => {
  it('Orange « momentanément injoignable » (422) → retryable PROVIDER_UNAVAILABLE', () => {
    const result = classifyInitRejection(
      422,
      'no_route_available',
      'Le service de paiement est momentanément injoignable.',
    );
    expect(result.outcome).toBe('retryable');
    expect(result.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('5xx → retryable même sans message', () => {
    expect(classifyInitRejection(503, null, null).outcome).toBe('retryable');
    expect(classifyInitRejection(502, 'x', 'Erreur interne.').outcome).toBe('retryable');
  });

  it('429 → retryable', () => {
    expect(classifyInitRejection(429, null, null).outcome).toBe('retryable');
  });

  it('422 invalid_method → validation ciblée (réseau)', () => {
    const result = classifyInitRejection(422, 'invalid_method', "Réseau inconnu ou inactif : 'mtn_xx'.");
    expect(result.outcome).toBe('validation');
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.message).toMatch(/réseau/i);
  });

  it('422 invalid_customer → validation ciblée (numéro)', () => {
    const result = classifyInitRejection(422, 'invalid_customer', 'Numéro invalide.');
    expect(result.error.message).toMatch(/numéro/i);
  });

  it('refus avec message sûr → repris tel quel (pas de raison inventée)', () => {
    const result = classifyInitRejection(400, 'x', 'Fonds insuffisants.');
    expect(result).toMatchObject({
      outcome: 'failed',
      error: { code: 'PAYMENT_FAILED', message: 'Fonds insuffisants.' },
    });
  });

  it('refus sans message sûr → texte générique, jamais le brut', () => {
    const result = classifyInitRejection(400, 'weird_code', null);
    expect(result.error.message).toMatch(/pas abouti/);
  });
});

describe('garde-fou message utilisateur', () => {
  it('secret ou structure technique → jamais exposé', () => {
    expect(isSafeUserMessage('Bearer sk_live_abc')).toBe(false);
    expect(isSafeUserMessage('{"code":"x"}')).toBe(false);
    expect(isSafeUserMessage('x'.repeat(201))).toBe(false);
    expect(isSafeUserMessage(null)).toBe(false);
    expect(isSafeUserMessage('Fonds insuffisants.')).toBe(true);
  });
});

describe('topupUserMessage (statut → texte UI)', () => {
  it('SUCCESS / PENDING / CANCELLED → textes fixes', () => {
    expect(topupUserMessage('SUCCESS', null)).toMatch(/confirmée/);
    expect(topupUserMessage('PENDING', null)).toMatch(/attente/);
    expect(topupUserMessage('CANCELLED', null)).toMatch(/annulé/);
  });

  it('FAILED transitoire stocké → indisponibilité ; FAILED validation → ciblé ; sinon générique', () => {
    expect(topupUserMessage('FAILED', 'SASPAY_INIT — service momentanément injoignable')).toMatch(
      /indisponible/,
    );
    expect(topupUserMessage('FAILED', 'SASPAY_INIT invalid_method — x')).toMatch(/réseau/i);
    expect(topupUserMessage('FAILED', 'SASPAY_INIT 400 — autre')).toMatch(/pas abouti/);
  });
});
