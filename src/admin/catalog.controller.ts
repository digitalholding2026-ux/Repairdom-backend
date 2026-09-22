import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { CatalogService } from './catalog.service.js';
import {
  CreateDomainDto,
  UpdateDomainDto,
  CreateProblemDto,
  UpdateProblemDto,
  CreateDiagnosticDto,
  UpdateDiagnosticDto,
  CreateInterventionDto,
  UpdateInterventionDto,
  CreatePricingDto,
  UpdatePricingDto,
  CreateBrandDto,
  UpdateBrandDto,
  CreateModelDto,
  UpdateModelDto,
  CreateCityDto,
  UpdateCityDto,
  CreateZoneDto,
  UpdateZoneDto,
} from './dto/catalog.dto.js';

@Controller('admin/catalog')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /* ── ServiceDomain ──────────────────────────────────────────── */

  @Get('domains')
  listDomains() {
    return this.catalog.listDomains();
  }

  @Get('domains/:id')
  getDomain(@Param('id') id: string) {
    return this.catalog.getDomain(id);
  }

  @Post('domains')
  createDomain(@Body() dto: CreateDomainDto) {
    return this.catalog.createDomain(dto);
  }

  @Patch('domains/:id')
  updateDomain(@Param('id') id: string, @Body() dto: UpdateDomainDto) {
    return this.catalog.updateDomain(id, dto);
  }

  /* Suppression administrative : physique si aucun dépendant, désactivation
   * (isActive = false) sinon — l'historique n'est jamais détruit. */
  @Delete('domains/:id')
  deleteDomain(@Param('id') id: string) {
    return this.catalog.deleteDomain(id);
  }

  /* ── DeviceBrand / DeviceModel ─────────────────────────────── */

  @Get('domains/:domainId/brands')
  listBrands(@Param('domainId') domainId: string) {
    return this.catalog.listBrands(domainId);
  }

  @Get('brands/:id')
  getBrand(@Param('id') id: string) {
    return this.catalog.getBrand(id);
  }

  @Post('brands')
  createBrand(@Body() dto: CreateBrandDto) {
    return this.catalog.createBrand(dto);
  }

  @Patch('brands/:id')
  updateBrand(@Param('id') id: string, @Body() dto: UpdateBrandDto) {
    return this.catalog.updateBrand(id, dto);
  }

  @Delete('brands/:id')
  deleteBrand(@Param('id') id: string) {
    return this.catalog.deleteBrand(id);
  }

  @Get('brands/:brandId/models')
  listModels(@Param('brandId') brandId: string) {
    return this.catalog.listModels(brandId);
  }

  @Get('models/:id')
  getModel(@Param('id') id: string) {
    return this.catalog.getModel(id);
  }

  @Post('models')
  createModel(@Body() dto: CreateModelDto) {
    return this.catalog.createModel(dto);
  }

  @Patch('models/:id')
  updateModel(@Param('id') id: string, @Body() dto: UpdateModelDto) {
    return this.catalog.updateModel(id, dto);
  }

  @Delete('models/:id')
  deleteModel(@Param('id') id: string) {
    return this.catalog.deleteModel(id);
  }

  /* ── Problem ────────────────────────────────────────────────── */

  @Get('domains/:domainId/problems')
  listProblems(
    @Param('domainId') domainId: string,
    @Query('brandId') brandId?: string,
    @Query('modelId') modelId?: string,
  ) {
    return this.catalog.listProblems(domainId, brandId, modelId);
  }

  @Get('problems/:id')
  getProblem(@Param('id') id: string) {
    return this.catalog.getProblem(id);
  }

  @Post('problems')
  createProblem(@Body() dto: CreateProblemDto) {
    return this.catalog.createProblem(dto);
  }

  @Patch('problems/:id')
  updateProblem(@Param('id') id: string, @Body() dto: UpdateProblemDto) {
    return this.catalog.updateProblem(id, dto);
  }

  @Delete('problems/:id')
  deleteProblem(@Param('id') id: string) {
    return this.catalog.deleteProblem(id);
  }

  /* ── CatalogDiagnostic ──────────────────────────────────────── */

  @Get('problems/:problemId/diagnostics')
  listDiagnostics(@Param('problemId') problemId: string) {
    return this.catalog.listDiagnostics(problemId);
  }

  @Get('diagnostics/:id')
  getDiagnostic(@Param('id') id: string) {
    return this.catalog.getDiagnostic(id);
  }

  @Post('diagnostics')
  createDiagnostic(@Body() dto: CreateDiagnosticDto) {
    return this.catalog.createDiagnostic(dto);
  }

  @Patch('diagnostics/:id')
  updateDiagnostic(@Param('id') id: string, @Body() dto: UpdateDiagnosticDto) {
    return this.catalog.updateDiagnostic(id, dto);
  }

  @Delete('diagnostics/:id')
  deleteDiagnostic(@Param('id') id: string) {
    return this.catalog.deleteDiagnostic(id);
  }

  /* ── CatalogIntervention ────────────────────────────────────── */

  @Get('diagnostics/:diagnosticId/interventions')
  listInterventions(@Param('diagnosticId') diagnosticId: string) {
    return this.catalog.listInterventions(diagnosticId);
  }

  @Get('interventions/:id')
  getIntervention(@Param('id') id: string) {
    return this.catalog.getIntervention(id);
  }

  @Post('interventions')
  createIntervention(@Body() dto: CreateInterventionDto) {
    return this.catalog.createIntervention(dto);
  }

  @Patch('interventions/:id')
  updateIntervention(@Param('id') id: string, @Body() dto: UpdateInterventionDto) {
    return this.catalog.updateIntervention(id, dto);
  }

  @Delete('interventions/:id')
  deleteIntervention(@Param('id') id: string) {
    return this.catalog.deleteIntervention(id);
  }

  /* ── Pricing ────────────────────────────────────────────────── */

  @Get('interventions/:interventionId/pricing')
  getPricing(@Param('interventionId') interventionId: string) {
    return this.catalog.getPricing(interventionId);
  }

  @Post('pricing')
  createPricing(@Body() dto: CreatePricingDto, @CurrentUser() user: RequestUser) {
    return this.catalog.createPricing(dto, user.id);
  }

  @Patch('interventions/:interventionId/pricing')
  updatePricing(
    @Param('interventionId') interventionId: string,
    @Body() dto: UpdatePricingDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.catalog.updatePricing(interventionId, dto, user.id);
  }

  @Delete('interventions/:interventionId/pricing')
  deletePricing(
    @Param('interventionId') interventionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.catalog.deletePricing(interventionId, user.id);
  }

  /* ── ServiceCity (zones de service) ─────────────────────────── */

  @Get('cities')
  listCities() {
    return this.catalog.listCities();
  }

  @Post('cities')
  createCity(@Body() dto: CreateCityDto) {
    return this.catalog.createCity(dto);
  }

  @Patch('cities/:id')
  updateCity(@Param('id') id: string, @Body() dto: UpdateCityDto) {
    return this.catalog.updateCity(id, dto);
  }

  @Delete('cities/:id')
  deleteCity(@Param('id') id: string) {
    return this.catalog.deleteCity(id);
  }

  /* ── Zone (quartiers/secteurs d'une ville) ───────────────────── */

  @Get('cities/:cityId/zones')
  listZones(@Param('cityId') cityId: string) {
    return this.catalog.listZones(cityId);
  }

  @Post('zones')
  createZone(@Body() dto: CreateZoneDto) {
    return this.catalog.createZone(dto);
  }

  @Patch('zones/:id')
  updateZone(@Param('id') id: string, @Body() dto: UpdateZoneDto) {
    return this.catalog.updateZone(id, dto);
  }

  @Delete('zones/:id')
  deleteZone(@Param('id') id: string) {
    return this.catalog.deleteZone(id);
  }

  /* ── Seed ───────────────────────────────────────────────────── */

  @Post('seed/smartphone')
  seedSmartphone() {
    // Sprint 8.7 — le seed est un outil de développement/initialisation
    // contrôlé : il ne doit jamais être déclenchable en production (il peut
    // autrement approfondir le référentiel sans validation administrée).
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('Le seed n\'est pas disponible en production.');
    }
    return this.catalog.seedSmartphoneDomain();
  }
}
