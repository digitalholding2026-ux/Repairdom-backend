import { describe, expect, it } from 'vitest';
import { SasPayConfig } from './saspay.config.js';

/* Correction garde-fou clé/mode (SasPay détermine l'environnement par la
 * clé ; SASPAY_MODE reste interne à Relio) :
 *   LIVE + sk_live_* = accepté ; LIVE + sk_test_* = refusé ;
 *   TEST + sk_test_* = accepté ; TEST + sk_live_* = refusé (aucun appel
 *   réel) ; REAL + LIVE = appel autorisé ; REAL + TEST = appel interdit.
 * Aucun appel réseau ici — pure logique de configuration. */

function configFor(values: Record<string, string | undefined>) {
  const config = { get: (key: string) => values[key] };
  return new SasPayConfig(config as never);
}

describe('garde-fou clé SasPay ↔ SASPAY_MODE', () => {
  it('LIVE + sk_live_* = accepté', () => {
    const cfg = configFor({ SASPAY_MODE: 'LIVE', SASPAY_API_KEY: 'sk_live_abc123' });
    expect(cfg.mode).toBe('LIVE');
    expect(cfg.keyModeMismatch()).toBeNull();
  });

  it('LIVE + sk_test_* = refusé', () => {
    const cfg = configFor({ SASPAY_MODE: 'LIVE', SASPAY_API_KEY: 'sk_test_abc123' });
    expect(cfg.keyModeMismatch()).toMatch(/non-live/);
  });

  it('TEST + sk_test_* = accepté', () => {
    const cfg = configFor({ SASPAY_MODE: 'TEST', SASPAY_API_KEY: 'sk_test_abc123' });
    expect(cfg.mode).toBe('TEST');
    expect(cfg.keyModeMismatch()).toBeNull();
  });

  it('TEST + sk_live_* = refusé (aucun appel réel possible)', () => {
    const cfg = configFor({ SASPAY_MODE: 'TEST', SASPAY_API_KEY: 'sk_live_abc123' });
    expect(cfg.keyModeMismatch()).toMatch(/appels réels désactivés/);
  });

  it('SASPAY_MODE absent = TEST ; clé live alors refusée', () => {
    const cfg = configFor({ SASPAY_API_KEY: 'sk_live_abc123' });
    expect(cfg.mode).toBe('TEST');
    expect(cfg.keyModeMismatch()).not.toBeNull();
  });

  it('clé absente ou au format inattendu = refusé', () => {
    expect(configFor({ SASPAY_MODE: 'LIVE' }).keyModeMismatch()).toMatch(/absente/);
    expect(
      configFor({ SASPAY_MODE: 'LIVE', SASPAY_API_KEY: 'not-a-key' }).keyModeMismatch(),
    ).toMatch(/format inattendu/);
    expect(
      configFor({ SASPAY_MODE: 'TEST', SASPAY_API_KEY: 'not-a-key' }).keyModeMismatch(),
    ).toMatch(/format inattendu/);
  });
});
