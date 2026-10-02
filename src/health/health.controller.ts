import { Controller, Get, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './../prisma/prisma.service.js';

/* Hostname Supabase seul (jamais la clé) : permet de vérifier depuis Railway
 * quelle URL est configurée sans exposer de secret. Aucun appel réseau ici —
 * le diagnostic de connectivité (DNS → HTTPS) reste manuel via
 * SupabaseStorageService.checkStorageConnectivity(), jamais en public. */
function storageHostOnly(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'non configuré';
  try {
    return new URL(trimmed).hostname || 'URL invalide';
  } catch {
    return 'URL invalide';
  }
}

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async check(): Promise<{
    status: string;
    database: string;
    uptime: number;
    timestamp: string;
    storageHost: string;
  }> {
    let database = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      database = 'down';
      this.logger.error('Database health check failed', error instanceof Error ? error.stack : undefined);
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      storageHost: storageHostOnly(this.config.get<string>('SUPABASE_URL')),
    };
  }

  /* Routes de diagnostic TEMPORAIRES (chantier reset password) : publiques,
   * sans auth, sans secret — noms et statuts uniquement. À SUPPRIMER au
   * chantier suivant (voir docs/UX-BACKLOG.md). But : vérifier depuis la
   * production (simple curl/navigateur) que la migration reset password est
   * bien appliquée sur Railway, sans accès Postgres direct. */

  /** Colonnes reset password réellement présentes sur "User". */
  @Get('db')
  async dbColumns(): Promise<{ columns: string[]; expected: number; ok: boolean }> {
    const expected = ['passwordResetToken', 'passwordResetExpiresAt', 'tokenVersion'];
    try {
      const rows = (await this.prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'User'
        AND column_name IN ('passwordResetToken', 'passwordResetExpiresAt', 'tokenVersion')
      `) as Array<{ column_name: string }>;
      const columns = rows.map((row) => row.column_name).sort();
      return { columns, expected: expected.length, ok: columns.length === expected.length };
    } catch (error) {
      this.logger.error('Database columns check failed', error instanceof Error ? error.stack : undefined);
      return { columns: [], expected: expected.length, ok: false };
    }
  }

  /** Migrations Prisma appliquées (noms + statuts, sans secret). */
  @Get('migrations')
  async appliedMigrations(): Promise<{
    migrations: Array<{ name: string; status: string }>;
  }> {
    try {
      const rows = (await this.prisma.$queryRaw`
        SELECT migration_name, finished_at, rolled_back_at
        FROM _prisma_migrations
        ORDER BY started_at ASC
      `) as Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>;
      return {
        migrations: rows.map((row) => ({
          name: row.migration_name,
          status: row.rolled_back_at ? 'rolled_back' : row.finished_at ? 'applied' : 'pending',
        })),
      };
    } catch (error) {
      this.logger.error('Migrations check failed', error instanceof Error ? error.stack : undefined);
      return { migrations: [] };
    }
  }
}