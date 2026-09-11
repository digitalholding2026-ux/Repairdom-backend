import {
  Body,
  Controller,
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

  /* ── Seed ───────────────────────────────────────────────────── */

  @Post('seed/smartphone')
  seedSmartphone() {
    return this.catalog.seedSmartphoneDomain();
  }
}
