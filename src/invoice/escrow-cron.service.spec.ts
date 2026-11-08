import { describe, expect, it } from 'vitest';
import { isEscrowOverdue, ESCROW_REFUND_HOURS } from './invoice.service.js';

describe('isEscrowOverdue (règle des 48h)', () => {
  const base = new Date('2026-11-08T12:00:00Z');

  it('retourne false quand escrowStartedAt est nul', () => {
    expect(isEscrowOverdue({ holdStartedAt: null, now: base })).toBe(false);
  });

  it('retourne false avant 48h', () => {
    const started = new Date(base.getTime() - 47 * 60 * 60 * 1000); // -47h
    expect(isEscrowOverdue({ holdStartedAt: started, now: base })).toBe(false);
  });

  it('retourne true exactement à 48h', () => {
    const started = new Date(base.getTime() - ESCROW_REFUND_HOURS * 60 * 60 * 1000);
    expect(isEscrowOverdue({ holdStartedAt: started, now: base })).toBe(true);
  });

  it('retourne true après 48h', () => {
    const started = new Date(base.getTime() - 49 * 60 * 60 * 1000); // -49h
    expect(isEscrowOverdue({ holdStartedAt: started, now: base })).toBe(true);
  });

  it('utilise le seuil personnalisé quand fourni', () => {
    const started = new Date(base.getTime() - 25 * 60 * 60 * 1000); // -25h
    expect(
      isEscrowOverdue({ holdStartedAt: started, now: base, hours: 24 }),
    ).toBe(true);
    expect(
      isEscrowOverdue({ holdStartedAt: started, now: base, hours: 26 }),
    ).toBe(false);
  });
});
