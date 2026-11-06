import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CatalogAdminService } from './catalog-admin.service.js';
import { CatalogAdminController } from './catalog-admin.controller.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogV2Service } from './catalog.service.js';

/**
 * M1 — catalogue Relio v2.
 *
 *   CatalogModule ──▶ AuthModule    (AuthService pour la lecture optionnelle
 *                                    de session, guards exportés)
 *   CatalogModule ──▶ PrismaModule  (global, implicite)
 *
 * Module parallèle au catalogue historique de `AdminModule` : aucun flux
 * existant n'est importé ni modifié ici.
 */
@Module({
  imports: [AuthModule],
  controllers: [CatalogController, CatalogAdminController],
  providers: [CatalogV2Service, CatalogAdminService],
  exports: [CatalogV2Service],
})
export class CatalogModule {}
