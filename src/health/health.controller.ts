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

  /* ── Routes de diagnostic — CONSERVÉES DÉLIBÉRÉMENT ────────────────────
   *
   * Ces deux routes étaient marquées « À SUPPRIMER » depuis le chantier reset
   * password. Elles sont MAINTENUES, et voici pourquoi : Railway applique les
   * migrations via le `startCommand`, sans que personne ne puisse voir leur
   * résultat de l'extérieur. Sans ces routes, la seule façon de savoir si une
   * migration est passée en production est d'ouvrir un tunnel vers Postgres.
   *
   * Ce qu'elles répondent, et ce qu'elles ne répondent PAS :
   *   • `GET /api/health/db`       → les NOMS de colonnes attendues sur
   *                                   `User` et leur présence, rien d'autre ;
   *   • `GET /api/health/migrations` → le NOM et le STATUT de chaque migration
   *                                   dans `_prisma_migrations`, rien d'autre.
   *
   * Aucune valeur, aucun contenu de ligne, aucune clé, aucun secret. C'est ce
   * qui les rend diagnosticables sans être exploitables : elles disent QUELLE
   * migration a échoué, jamais CE QU'ELLE contient.
   *
   * ⚠️ SI LE PRODUIT INSTALLE UN JOUR UN RÉFÉRENTIEL UTILISATEUR, ces routes
   * deviendront une fuite d'infrastructure et devront être retirées à ce
   * moment-là — pas avant. Tant que le seul risque est « un attaquant apprend
   * qu'une migration a échoué », le coût de les garder est nul et leur
   * valeur opérationnelle est réelle : c'est le seul moyen de vérifier une
   * migration depuis un navigateur.
   */

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