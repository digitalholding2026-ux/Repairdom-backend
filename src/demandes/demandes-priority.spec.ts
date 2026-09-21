import { describe, expect, it } from 'vitest';
import { compareDemandePriority } from './demandes.service.js';

/* Matching intelligent — Phase 7 : critères existants préservés.
 * La priorité ASAP / programmé est inchangée ; ce spec fige le comportement
 * (cas 19 : ASAP d'abord ; cas 20 : programmé trié par récence). */

const ASAP = { requestedMode: 'ASAP', createdAt: new Date('2026-09-20T10:00:00Z') };
const ASAP_OLDER = { requestedMode: 'ASAP', createdAt: new Date('2026-09-19T10:00:00Z') };
const SCHEDULED_NEW = { requestedMode: 'SCHEDULED', createdAt: new Date('2026-09-20T12:00:00Z') };
const SCHEDULED_OLD = { requestedMode: 'SCHEDULED', createdAt: new Date('2026-09-18T10:00:00Z') };

describe('compareDemandePriority (cas 19/20)', () => {
  it('cas 19 : ASAP avant programmé, même plus ancien', () => {
    expect(compareDemandePriority(ASAP_OLDER, SCHEDULED_NEW)).toBeLessThan(0);
    expect(compareDemandePriority(SCHEDULED_NEW, ASAP_OLDER)).toBeGreaterThan(0);
  });

  it('cas 20 : programmé trié par récence, ASAP triées par récence', () => {
    expect(compareDemandePriority(SCHEDULED_NEW, SCHEDULED_OLD)).toBeLessThan(0);
    expect(compareDemandePriority(ASAP, ASAP_OLDER)).toBeLessThan(0);
    expect(compareDemandePriority(ASAP, { ...ASAP })).toBe(0);
  });

  it('tri complet : ASAP récentes et anciennes avant programmées', () => {
    const sorted = [SCHEDULED_OLD, ASAP_OLDER, SCHEDULED_NEW, ASAP].sort(compareDemandePriority);
    expect(sorted).toEqual([ASAP, ASAP_OLDER, SCHEDULED_NEW, SCHEDULED_OLD]);
  });
});
