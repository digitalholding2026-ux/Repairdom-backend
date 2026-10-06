import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CatalogService } from './catalog.service.js';
import { NATIONALITIES } from '../technician/nationalities.js';

/* Catalogue public — Sprint 8.1, rendu réellement public au chantier FIX.
 *
 * Sert uniquement les référentiels actifs (domaines actifs, marques actives,
 * modèles actifs, problèmes proposables selon la spécificité marque/modèle) et
 * NE JAMAIS les données tarifaires. Le pricing n'est consulté qu'au moment de
 * la sélection du diagnostic par le technicien, sous contrôle du backend
 * (réponse filtrée selon la politique de visibilité).
 *
 * ── POURQUOI CES ROUTES SONT MAINTENANT ANONYMES ────────────────────
 * Le chantier D2 a rendu le wizard de demande PUBLIC (`/demande`, hors du
 * layout `/client`, donc hors du `RoleGuard`). Mais ces endpoints étaient
 * encore protégés : un visiteur sans compte recevait 401 et le wizard
 * affichait « Catalogue indisponible » — il ne pouvait littéralement pas
 * décrire sa panne. Le tunnel était ouvert à l'entrée mais muré à la première
 * étape.
 *
 * L'exposition est sans risque, et ce n'est pas une évidence :
 *  - AUCUNE PII : ces `select` explicites ne sortent que `id`, `name`, `slug`,
 *    `icon`, `category` et des `_count`. Jamais d'e-mail, de téléphone,
 *    d'adresse, jamais d'identifiant de compte.
 *  - AUCUNE donnée tarifaire : ni prix, ni min/max, ni marge. Le pricing
 *    reste hors de ce controller par construction.
 *  - Référentiels déjà publics par ailleurs : `/api/cities` l'est depuis
 *    longtemps et sert exactement le même type de données.
 * Un concurrent qui scrape ces listes n'apprend rien qu'il ne puisse pas
 * déduire en une minute d'une page publique.
 *
 * ⚠️ CONSÉQUENCE À GARDER EN TÊTE : retirer le `@UseGuards` de la CLASSE est
 * ce qui rend ces routes publiques. Ajouter une nouvelle route GET ici sans
 * y ajouter explicitement les guards la rendra PUBLIQUE par défaut. C'est
 * voulu pour les référentiels, dangereux pour une donnée de compte : en cas
 * de doute, protège au niveau de la MÉTHODE.
 */
@Controller('catalog')
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

  @Get('families')
  listFamilies() {
    return this.catalog.listPublicFamilies();
  }

  @Get('domains/:domainId/problems')
  listProblems(
    @Param('domainId') domainId: string,
    @Query('brandId') brandId?: string,
    @Query('modelId') modelId?: string,
  ) {
    return this.catalog.listPublicProblems(domainId, brandId, modelId);
  }

  /* Même payload que `GET /api/cities` (`CityPublicController`), déjà public
   * depuis le sprint initial — celui-ci est donc aligné, pas élargi. */
  @Get('cities')
  listCities() {
    return this.catalog.listPublicCities();
  }

  /* Nomenclature ISO 3166-1 alpha-2 (KYC technicien). Servie par le backend
   * afin que le sélecteur du frontend et la validation serveur partagent
   * EXACTEMENT la même liste : le frontend ne duplique pas 249 pays, et le
   * backend ne peut pas rejeter un pays que l'UI affiche.
   *
   * RESTE PROTÉGÉE, volontairement. La liste elle-même n'a rien de sensible,
   * mais elle n'est consommée que par `/technicien/kyc`, une page déjà
   * protégée : la garder fermée ne coûte rien et évite d'ouvrir par
   * inadvertance une route du KYC. Les guards sont donc posés au niveau
   * méthode, puisque ceux de la classe ont été retirés. */
  @Get('nationalities')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT', 'TECHNICIAN', 'ADMIN')
  listNationalities() {
    return NATIONALITIES;
  }
}