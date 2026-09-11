import { Controller, Get } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';

/* Zones de service publique — accessibles SANS authentification.
 *
 * Nécessaire au formulaire d'inscription client (sélection de la ville avant
 * toute création de compte) et au parcours « demande » anonyme. Contrairement
 * aux endpoints `catalog/*` (réservés aux comptes connectés), cette route ne
 * renvoie que les villes actives : aucune donnée métier sensible. */

@Controller('cities')
export class CityPublicController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  listCities() {
    return this.catalog.listPublicCities();
  }
}