import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';

/* Routes de diagnostic temporaires (chantier reset password) : publiques,
 * sans secret — vérifiables en production par simple curl. */

function controller(queryRaw: (strings: TemplateStringsArray) => Promise<unknown>) {
  const prisma = { $queryRaw: vi.fn(queryRaw) } as never;
  return new HealthController(prisma, { get: vi.fn(() => undefined) } as never);
}

describe('GET /health/db', () => {
  it('3 colonnes présentes → ok: true', async () => {
    const ctl = controller(async () => [
      { column_name: 'passwordResetToken' },
      { column_name: 'passwordResetExpiresAt' },
      { column_name: 'tokenVersion' },
    ]);
    await expect(ctl.dbColumns()).resolves.toEqual({
      columns: ['passwordResetExpiresAt', 'passwordResetToken', 'tokenVersion'],
      expected: 3,
      ok: true,
    });
  });

  it('migration non appliquée → ok: false', async () => {
    const ctl = controller(async () => [{ column_name: 'tokenVersion' }]);
    const result = await ctl.dbColumns();
    expect(result.ok).toBe(false);
    expect(result.expected).toBe(3);
  });

  it('base injoignable → ok: false sans exception', async () => {
    const ctl = controller(async () => {
      throw new Error('down');
    });
    await expect(ctl.dbColumns()).resolves.toEqual({ columns: [], expected: 3, ok: false });
  });
});

describe('GET /health/migrations', () => {
  it('liste noms + statuts dérivés', async () => {
    const ctl = controller(async () => [
      {
        migration_name: '20261006010000_demande_disputes',
        finished_at: new Date(),
        rolled_back_at: null,
      },
      {
        migration_name: '20261007010000_add_password_reset_fields',
        finished_at: new Date(),
        rolled_back_at: null,
      },
    ]);
    await expect(ctl.appliedMigrations()).resolves.toEqual({
      migrations: [
        { name: '20261006010000_demande_disputes', status: 'applied' },
        { name: '20261007010000_add_password_reset_fields', status: 'applied' },
      ],
    });
  });

  it('base injoignable → liste vide sans exception', async () => {
    const ctl = controller(async () => {
      throw new Error('down');
    });
    await expect(ctl.appliedMigrations()).resolves.toEqual({ migrations: [] });
  });
});
