import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CatalogService } from './catalog.service.js';

/* Catalogue public (client/technicien) — Sprint 8.1.
 *
 * Sert uniquement les référentiels actifs (domaines actifs, marques actives,
 * modèles actifs, problèmes proposables selon la spécificité marque/modèle) et
 * NE JAMAIS les données tarifaires. Le pricing n'est consulté qu'au moment de
 * la sélection du diagnostic par le technicien, sous contrôle du backend
 * (réponse filtrée selon la politique de visibilité). */

@Controller('catalog')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT', 'TECHNICIAN', 'ADMIN')
export class CatalogPublicController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('domains')
  listDomains() {
    return this.catalog.listPublicDomains();
  }

  @Get('domains/:domainId/brands')
  listBrands(@Param('domainId') domainId: string) {
    return this.catalog.listPublicBrands(domainId);
  }

  @Get('brands/:brandId/models')
  listModels(@Param('brandId') brandId: string) {
    return this.catalog.listPublicModels(brandId);
  }

  @Get('domains/:domainId/problems')
  listProblems(
    @Param('domainId') domainId: string,
    @Query('brandId') brandId?: string,
    @Query('modelId') modelId?: string,
  ) {
    return this.catalog.listPublicProblems(domainId, brandId, modelId);
  }
}