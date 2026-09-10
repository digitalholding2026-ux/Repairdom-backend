import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { toAdminPricing } from './pricing-visibility.js';
import type {
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

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /* ── ServiceDomain ──────────────────────────────────────────── */

  async listDomains() {
    return this.prisma.serviceDomain.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { problems: true, brands: true } },
      },
    });
  }

  async getDomain(id: string) {
    const domain = await this.prisma.serviceDomain.findUnique({
      where: { id },
      include: {
        problems: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: { _count: { select: { diagnostics: true } } },
        },
        brands: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: { _count: { select: { models: true } } },
        },
      },
    });
    if (!domain) throw new NotFoundException('Domaine introuvable.');
    return domain;
  }

  async createDomain(dto: CreateDomainDto) {
    const slug = dto.slug.trim().toLowerCase();
    const existing = await this.prisma.serviceDomain.findUnique({ where: { slug } });
    if (existing) throw new BadRequestException('Ce slug existe déjà.');
    return this.prisma.serviceDomain.create({
      data: {
        name: dto.name.trim(),
        slug,
        description: dto.description?.trim() || null,
        icon: dto.icon?.trim() || null,
        category: dto.category?.trim() || null,
      },
    });
  }

  async updateDomain(id: string, dto: UpdateDomainDto) {
    const domain = await this.prisma.serviceDomain.findUnique({ where: { id } });
    if (!domain) throw new NotFoundException('Domaine introuvable.');
    if (dto.slug) {
      const slug = dto.slug.trim().toLowerCase();
      const conflict = await this.prisma.serviceDomain.findFirst({
        where: { slug, NOT: { id } },
      });
      if (conflict) throw new BadRequestException('Ce slug existe déjà.');
    }
    return this.prisma.serviceDomain.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug.trim().toLowerCase() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon?.trim() || null } : {}),
        ...(dto.category !== undefined ? { category: dto.category?.trim() || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  /* ── DeviceBrand / DeviceModel ───────────────────────────────── */

  async listBrands(domainId: string) {
    const domain = await this.prisma.serviceDomain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domaine introuvable.');
    return this.prisma.deviceBrand.findMany({
      where: { domainId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { models: true } } },
    });
  }

  async getBrand(id: string) {
    const brand = await this.prisma.deviceBrand.findUnique({
      where: { id },
      include: {
        domain: true,
        models: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: { _count: { select: { problems: true } } },
        },
      },
    });
    if (!brand) throw new NotFoundException('Marque introuvable.');
    return brand;
  }

  async createBrand(dto: CreateBrandDto) {
    const domain = await this.prisma.serviceDomain.findUnique({ where: { id: dto.domainId } });
    if (!domain) throw new NotFoundException('Domaine introuvable.');
    const slug = dto.slug.trim().toLowerCase();
    const existing = await this.prisma.deviceBrand.findFirst({
      where: { domainId: dto.domainId, slug },
    });
    if (existing) throw new BadRequestException('Ce slug existe déjà pour ce domaine.');
    return this.prisma.deviceBrand.create({
      data: {
        domainId: dto.domainId,
        name: dto.name.trim(),
        slug,
        description: dto.description?.trim() || null,
      },
    });
  }

  async updateBrand(id: string, dto: UpdateBrandDto) {
    const brand = await this.prisma.deviceBrand.findUnique({ where: { id } });
    if (!brand) throw new NotFoundException('Marque introuvable.');
    if (dto.slug) {
      const slug = dto.slug.trim().toLowerCase();
      const conflict = await this.prisma.deviceBrand.findFirst({
        where: { domainId: brand.domainId, slug, NOT: { id } },
      });
      if (conflict) throw new BadRequestException('Ce slug existe déjà pour ce domaine.');
    }
    return this.prisma.deviceBrand.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug.trim().toLowerCase() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  async listModels(brandId: string) {
    const brand = await this.prisma.deviceBrand.findUnique({ where: { id: brandId } });
    if (!brand) throw new NotFoundException('Marque introuvable.');
    return this.prisma.deviceModel.findMany({
      where: { brandId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { problems: true } } },
    });
  }

  async createModel(dto: CreateModelDto) {
    const brand = await this.prisma.deviceBrand.findUnique({ where: { id: dto.brandId } });
    if (!brand) throw new NotFoundException('Marque introuvable.');
    const slug = dto.slug.trim().toLowerCase();
    const existing = await this.prisma.deviceModel.findFirst({
      where: { brandId: dto.brandId, slug },
    });
    if (existing) throw new BadRequestException('Ce slug existe déjà pour cette marque.');
    return this.prisma.deviceModel.create({
      data: {
        brandId: dto.brandId,
        name: dto.name.trim(),
        slug,
        description: dto.description?.trim() || null,
      },
    });
  }

  async updateModel(id: string, dto: UpdateModelDto) {
    const model = await this.prisma.deviceModel.findUnique({ where: { id } });
    if (!model) throw new NotFoundException('Modèle introuvable.');
    if (dto.slug) {
      const slug = dto.slug.trim().toLowerCase();
      const conflict = await this.prisma.deviceModel.findFirst({
        where: { brandId: model.brandId, slug, NOT: { id } },
      });
      if (conflict) throw new BadRequestException('Ce slug existe déjà pour cette marque.');
    }
    return this.prisma.deviceModel.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug.trim().toLowerCase() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  /* ── Catalogue public (client/technicien) ────────────────────── */

  /* Endpoints publics : uniquement les éléments actifs et aucune donnée
   * tarifaire. Les marques/modèles/problèmes sont servis sans min/max ni
   * pricing (ce dernier n'est consulté qu'au moment de la sélection du
   * diagnostic, sous contrôle du backend). */

  async listPublicDomains() {
    return this.prisma.serviceDomain.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        icon: true,
        category: true,
        _count: { select: { brands: true, problems: true } },
      },
    });
  }

  async listPublicBrands(domainId: string) {
    const domain = await this.prisma.serviceDomain.findUnique({
      where: { id: domainId, isActive: true },
    });
    if (!domain) throw new NotFoundException('Domaine introuvable.');
    return this.prisma.deviceBrand.findMany({
      where: { domainId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        _count: { select: { models: true } },
      },
    });
  }

  async listPublicModels(brandId: string) {
    const brand = await this.prisma.deviceBrand.findUnique({
      where: { id: brandId, isActive: true },
    });
    if (!brand) throw new NotFoundException('Marque introuvable.');
    return this.prisma.deviceModel.findMany({
      where: { brandId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true },
    });
  }

  /* Problèmes proposables pour un domaine, filtrés par la spécificité
   * marque/modèle connue du client. Un problème générique (ni marque ni
   * modèle) reste toujours proposable ; un problème ancré marque/modèle
   * n'est proposable que lorsque le client a renseigné ce contexte. */
  async listPublicProblems(domainId: string, brandId?: string, modelId?: string) {
    const domain = await this.prisma.serviceDomain.findUnique({
      where: { id: domainId, isActive: true },
    });
    if (!domain) throw new NotFoundException('Domaine introuvable.');
    return this.prisma.problem.findMany({
      where: {
        domainId,
        isActive: true,
        ...(brandId
          ? { OR: [{ brandId: null }, { brandId }] }
          : { brandId: null }),
        ...(modelId
          ? { OR: [{ modelId: null }, { modelId }] }
          : { modelId: null }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true },
    });
  }

  /* ── Problem ────────────────────────────────────────────────── */

  async listProblems(domainId: string, brandId?: string, modelId?: string) {
    const domain = await this.prisma.serviceDomain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domaine introuvable.');
    return this.prisma.problem.findMany({
      where: {
        domainId,
        ...(brandId
          ? { OR: [{ brandId: null }, { brandId }] }
          : { brandId: null }),
        ...(modelId
          ? { OR: [{ modelId: null }, { modelId }] }
          : { modelId: null }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        brand: { select: { id: true, name: true } },
        model: { select: { id: true, name: true } },
        _count: { select: { diagnostics: true } },
      },
    });
  }

  async getProblem(id: string) {
    const problem = await this.prisma.problem.findUnique({
      where: { id },
      include: {
        domain: true,
        brand: true,
        model: true,
        diagnostics: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: { _count: { select: { interventions: true } } },
        },
      },
    });
    if (!problem) throw new NotFoundException('Problème introuvable.');
    return problem;
  }

  private async assertBrandModelForProblem(
    domainId: string,
    brandId: string | undefined,
    modelId: string | undefined,
  ) {
    if (modelId && !brandId) {
      throw new BadRequestException('Un modèle doit être rattaché à une marque.');
    }
    if (brandId) {
      const brand = await this.prisma.deviceBrand.findUnique({ where: { id: brandId } });
      if (!brand || brand.domainId !== domainId) {
        throw new BadRequestException('La marque ne dépend pas de ce domaine.');
      }
    }
    if (modelId) {
      const model = await this.prisma.deviceModel.findUnique({ where: { id: modelId } });
      if (!model) throw new BadRequestException('Modèle introuvable.');
      if (!brandId || model.brandId !== brandId) {
        throw new BadRequestException('Le modèle ne dépend pas de cette marque.');
      }
    }
  }

  async createProblem(dto: CreateProblemDto) {
    const domain = await this.prisma.serviceDomain.findUnique({ where: { id: dto.domainId } });
    if (!domain) throw new NotFoundException('Domaine introuvable.');
    await this.assertBrandModelForProblem(
      dto.domainId,
      dto.brandId ?? undefined,
      dto.modelId ?? undefined,
    );
    const slug = dto.slug.trim().toLowerCase();
    const existing = await this.prisma.problem.findFirst({
      where: { domainId: dto.domainId, slug },
    });
    if (existing) throw new BadRequestException('Ce slug existe déjà pour ce domaine.');
    return this.prisma.problem.create({
      data: {
        domainId: dto.domainId,
        brandId: dto.brandId ?? null,
        modelId: dto.modelId ?? null,
        name: dto.name.trim(),
        slug,
        description: dto.description?.trim() || null,
      },
    });
  }

  async updateProblem(id: string, dto: UpdateProblemDto) {
    const problem = await this.prisma.problem.findUnique({ where: { id } });
    if (!problem) throw new NotFoundException('Problème introuvable.');
    if (dto.brandId !== undefined || dto.modelId !== undefined) {
      const brandId = dto.brandId === undefined ? problem.brandId : (dto.brandId ?? null);
      const modelId = dto.modelId === undefined ? problem.modelId : (dto.modelId ?? null);
      await this.assertBrandModelForProblem(
        problem.domainId,
        brandId ?? undefined,
        modelId ?? undefined,
      );
    }
    if (dto.slug) {
      const slug = dto.slug.trim().toLowerCase();
      const conflict = await this.prisma.problem.findFirst({
        where: { domainId: problem.domainId, slug, NOT: { id } },
      });
      if (conflict) throw new BadRequestException('Ce slug existe déjà pour ce domaine.');
    }
    return this.prisma.problem.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug.trim().toLowerCase() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(dto.brandId !== undefined ? { brandId: dto.brandId ?? null } : {}),
        ...(dto.modelId !== undefined ? { modelId: dto.modelId ?? null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  /* ── CatalogDiagnostic ──────────────────────────────────────── */

  async listDiagnostics(problemId: string) {
    const problem = await this.prisma.problem.findUnique({ where: { id: problemId } });
    if (!problem) throw new NotFoundException('Problème introuvable.');
    return this.prisma.catalogDiagnostic.findMany({
      where: { problemId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { interventions: true } } },
    });
  }

  async getDiagnostic(id: string) {
    const diagnostic = await this.prisma.catalogDiagnostic.findUnique({
      where: { id },
      include: {
        problem: { include: { domain: true } },
        interventions: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: { pricing: true },
        },
      },
    });
    if (!diagnostic) throw new NotFoundException('Diagnostic introuvable.');
    return {
      ...diagnostic,
      interventions: diagnostic.interventions.map((intervention) => ({
        ...intervention,
        pricing: intervention.pricing ? toAdminPricing(intervention.pricing) : null,
      })),
    };
  }

  async createDiagnostic(dto: CreateDiagnosticDto) {
    const problem = await this.prisma.problem.findUnique({ where: { id: dto.problemId } });
    if (!problem) throw new NotFoundException('Problème introuvable.');
    const slug = dto.slug.trim().toLowerCase();
    const existing = await this.prisma.catalogDiagnostic.findFirst({
      where: { problemId: dto.problemId, slug },
    });
    if (existing) throw new BadRequestException('Ce slug existe déjà pour ce problème.');
    return this.prisma.catalogDiagnostic.create({
      data: {
        problemId: dto.problemId,
        name: dto.name.trim(),
        slug,
        description: dto.description?.trim() || null,
        confidence: dto.confidence?.trim() || null,
        difficulty: dto.difficulty?.trim() || null,
        estimatedTime: dto.estimatedTime?.trim() || null,
        internalNotes: dto.internalNotes?.trim() || null,
      },
    });
  }

  async updateDiagnostic(id: string, dto: UpdateDiagnosticDto) {
    const diagnostic = await this.prisma.catalogDiagnostic.findUnique({ where: { id } });
    if (!diagnostic) throw new NotFoundException('Diagnostic introuvable.');
    if (dto.slug) {
      const slug = dto.slug.trim().toLowerCase();
      const conflict = await this.prisma.catalogDiagnostic.findFirst({
        where: { problemId: diagnostic.problemId, slug, NOT: { id } },
      });
      if (conflict) throw new BadRequestException('Ce slug existe déjà pour ce problème.');
    }
    return this.prisma.catalogDiagnostic.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug.trim().toLowerCase() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(dto.confidence !== undefined ? { confidence: dto.confidence?.trim() || null } : {}),
        ...(dto.difficulty !== undefined ? { difficulty: dto.difficulty?.trim() || null } : {}),
        ...(dto.estimatedTime !== undefined ? { estimatedTime: dto.estimatedTime?.trim() || null } : {}),
        ...(dto.internalNotes !== undefined ? { internalNotes: dto.internalNotes?.trim() || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  /* ── CatalogIntervention ────────────────────────────────────── */

  async listInterventions(diagnosticId: string) {
    const diagnostic = await this.prisma.catalogDiagnostic.findUnique({ where: { id: diagnosticId } });
    if (!diagnostic) throw new NotFoundException('Diagnostic introuvable.');
    return this.prisma.catalogIntervention
      .findMany({
        where: { diagnosticId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: { pricing: true },
      })
      .then((items) =>
        items.map((item) => ({
          ...item,
          pricing: item.pricing ? toAdminPricing(item.pricing) : null,
        })),
      );
  }

  async getIntervention(id: string) {
    const intervention = await this.prisma.catalogIntervention.findUnique({
      where: { id },
      include: {
        diagnostic: { include: { problem: { include: { domain: true } } } },
        pricing: true,
      },
    });
    if (!intervention) throw new NotFoundException('Intervention introuvable.');
    return {
      ...intervention,
      pricing: intervention.pricing ? toAdminPricing(intervention.pricing) : null,
    };
  }

  async createIntervention(dto: CreateInterventionDto) {
    const diagnostic = await this.prisma.catalogDiagnostic.findUnique({ where: { id: dto.diagnosticId } });
    if (!diagnostic) throw new NotFoundException('Diagnostic introuvable.');
    const slug = dto.slug.trim().toLowerCase();
    const existing = await this.prisma.catalogIntervention.findFirst({
      where: { diagnosticId: dto.diagnosticId, slug },
    });
    if (existing) throw new BadRequestException('Ce slug existe déjà pour ce diagnostic.');
    return this.prisma.catalogIntervention.create({
      data: {
        diagnosticId: dto.diagnosticId,
        name: dto.name.trim(),
        slug,
        description: dto.description?.trim() || null,
        difficulty: dto.difficulty?.trim() || null,
        estimatedTime: dto.estimatedTime?.trim() || null,
        needsParts: dto.needsParts ?? false,
        partsNote: dto.partsNote?.trim() || null,
      },
    });
  }

  async updateIntervention(id: string, dto: UpdateInterventionDto) {
    const intervention = await this.prisma.catalogIntervention.findUnique({ where: { id } });
    if (!intervention) throw new NotFoundException('Intervention introuvable.');
    if (dto.slug) {
      const slug = dto.slug.trim().toLowerCase();
      const conflict = await this.prisma.catalogIntervention.findFirst({
        where: { diagnosticId: intervention.diagnosticId, slug, NOT: { id } },
      });
      if (conflict) throw new BadRequestException('Ce slug existe déjà pour ce diagnostic.');
    }
    return this.prisma.catalogIntervention.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug.trim().toLowerCase() } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(dto.difficulty !== undefined ? { difficulty: dto.difficulty?.trim() || null } : {}),
        ...(dto.estimatedTime !== undefined ? { estimatedTime: dto.estimatedTime?.trim() || null } : {}),
        ...(dto.needsParts !== undefined ? { needsParts: dto.needsParts } : {}),
        ...(dto.partsNote !== undefined ? { partsNote: dto.partsNote?.trim() || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  /* ── Pricing ────────────────────────────────────────────────── */

  /* Politique de visibilité tarifaire partagée (voir pricing-visibility.ts). */

  async getPricing(interventionId: string) {
    const pricing = await this.prisma.pricing.findUnique({
      where: { interventionId },
      include: {
        intervention: {
          include: { diagnostic: { include: { problem: { include: { domain: true } } } } },
        },
        history: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });
    if (!pricing) throw new NotFoundException('Tarification introuvable.');
    return {
      ...toAdminPricing(pricing),
      intervention: pricing.intervention,
    };
  }

  async createPricing(dto: CreatePricingDto, _adminId: string) {
    const intervention = await this.prisma.catalogIntervention.findUnique({
      where: { id: dto.interventionId },
    });
    if (!intervention) throw new NotFoundException('Intervention introuvable.');
    const existing = await this.prisma.pricing.findUnique({
      where: { interventionId: dto.interventionId },
    });
    if (existing) throw new BadRequestException('Une tarification existe déjà pour cette intervention.');
    return this.prisma.pricing.create({
      data: {
        interventionId: dto.interventionId,
        minPrice: dto.minPrice ?? null,
        referencePrice: dto.referencePrice ?? null,
        maxPrice: dto.maxPrice ?? null,
        travelFee: dto.travelFee ?? null,
        serviceFee: dto.serviceFee ?? null,
        currency: dto.currency?.trim().toUpperCase() || 'XAF',
        priceMode: dto.priceMode?.trim() || 'fixed',
      },
    });
  }

  async updatePricing(interventionId: string, dto: UpdatePricingDto, adminId: string) {
    const pricing = await this.prisma.pricing.findUnique({ where: { interventionId } });
    if (!pricing) throw new NotFoundException('Tarification introuvable.');
    const previousValues = {
      minPrice: pricing.minPrice,
      referencePrice: pricing.referencePrice,
      maxPrice: pricing.maxPrice,
      travelFee: pricing.travelFee,
      serviceFee: pricing.serviceFee,
      currency: pricing.currency,
      priceMode: pricing.priceMode,
      isActive: pricing.isActive,
    };
    const newData: Record<string, unknown> = {};
    if (dto.minPrice !== undefined) newData.minPrice = dto.minPrice ?? null;
    if (dto.referencePrice !== undefined) newData.referencePrice = dto.referencePrice ?? null;
    if (dto.maxPrice !== undefined) newData.maxPrice = dto.maxPrice ?? null;
    if (dto.travelFee !== undefined) newData.travelFee = dto.travelFee ?? null;
    if (dto.serviceFee !== undefined) newData.serviceFee = dto.serviceFee ?? null;
    if (dto.currency !== undefined) newData.currency = dto.currency.trim().toUpperCase();
    if (dto.priceMode !== undefined) newData.priceMode = dto.priceMode.trim();
    if (dto.isActive !== undefined) newData.isActive = dto.isActive;

    if (Object.keys(newData).length === 0) return pricing;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.pricing.update({
        where: { interventionId },
        data: newData,
      });
      const newValues = { ...previousValues, ...newData };
      await tx.pricingHistory.create({
        data: {
          pricingId: pricing.id,
          adminId,
          previousValues,
          newValues,
          reason: dto.reason?.trim() || null,
        },
      });
      return updated;
    });
  }

  /* ── Seed: Smartphone domain ────────────────────────────────── */

  async seedSmartphoneDomain() {
    const existing = await this.prisma.serviceDomain.findUnique({ where: { slug: 'smartphone' } });

    const domain = existing
      ? await this.prisma.serviceDomain.update({
          where: { id: existing.id },
          data: {
            name: 'Smartphone',
            description: 'Réparation et maintenance de smartphones',
            icon: 'smartphone',
            category: 'informatique',
          },
        })
      : await this.prisma.serviceDomain.create({
          data: {
            name: 'Smartphone',
            slug: 'smartphone',
            description: 'Réparation et maintenance de smartphones',
            icon: 'smartphone',
            // Catégorie métier historique (matching) : les demandes issues du
            // domaine Smartphone sont rattachées à « informatique ».
            category: 'informatique',
          },
        });

    await this.seedSmartphoneBrands(domain.id);
    await this.seedSmartphoneProblems(domain.id);

    return {
      message: 'Domaine Smartphone vérifié.',
      domainId: domain.id,
    };
  }

  private async seedSmartphoneBrands(domainId: string) {
    const brands: Array<{
      slug: string;
      name: string;
      models: Array<{ slug: string; name: string }>;
    }> = [
      {
        slug: 'tecno',
        name: 'Tecno',
        models: [
          { slug: 'spark-10', name: 'Spark 10' },
          { slug: 'spark-5', name: 'Spark 5' },
          { slug: 'camon-20', name: 'Camon 20' },
        ],
      },
      {
        slug: 'infinix',
        name: 'Infinix',
        models: [
          { slug: 'hot-30', name: 'Hot 30' },
          { slug: 'note-40', name: 'Note 40' },
        ],
      },
      {
        slug: 'itel',
        name: 'itel',
        models: [
          { slug: 'a60', name: 'A60' },
          { slug: 's23', name: 'S23' },
        ],
      },
      {
        slug: 'samsung',
        name: 'Samsung',
        models: [
          { slug: 'galaxy-a15', name: 'Galaxy A15' },
          { slug: 'galaxy-a05', name: 'Galaxy A05' },
        ],
      },
      {
        slug: 'apple',
        name: 'Apple',
        models: [
          { slug: 'iphone-13', name: 'iPhone 13' },
          { slug: 'iphone-12', name: 'iPhone 12' },
        ],
      },
      { slug: 'autres', name: 'Autres', models: [] },
    ];

    let brandSort = 0;
    for (const brand of brands) {
      const record = await this.prisma.deviceBrand.upsert({
        where: { domainId_slug: { domainId, slug: brand.slug } },
        create: {
          domainId,
          name: brand.name,
          slug: brand.slug,
          sortOrder: brandSort++,
        },
        update: { name: brand.name, sortOrder: brandSort++ },
      });
      let modelSort = 0;
      for (const model of brand.models) {
        await this.prisma.deviceModel.upsert({
          where: { brandId_slug: { brandId: record.id, slug: model.slug } },
          create: {
            brandId: record.id,
            name: model.name,
            slug: model.slug,
            sortOrder: modelSort++,
          },
          update: { name: model.name, sortOrder: modelSort++ },
        });
      }
    }
  }

  private async seedSmartphoneProblems(domainId: string) {
    const problems = [
      {
        slug: 'ecran-casse',
        name: 'Écran cassé',
        description: 'Écran fissuré ou brisé',
        diags: [
          {
            slug: 'remplacement-ecran',
            name: 'Remplacement écran',
            description: "Remplacement de l'écran endommagé",
            difficulty: 'Moyen',
            estimatedTime: '30-60 min',
            interventions: [
              {
                slug: 'remplacement-ecran-standard',
                name: "Remplacement écran standard",
                description: "Remplacement écran LCD/OLED standard",
                difficulty: 'Moyen',
                estimatedTime: '30-45 min',
                needsParts: true,
                partsNote: 'Écran compatible de qualité',
                pricing: { minPrice: 15000, referencePrice: 25000, maxPrice: 40000, travelFee: 2000, serviceFee: 3000 },
              },
              {
                slug: 'remplacement-ecran-premium',
                name: "Remplacement écran premium",
                description: "Remplacement écran OEM/original",
                difficulty: 'Moyen',
                estimatedTime: '45-60 min',
                needsParts: true,
                partsNote: 'Écran OEM ou original',
                pricing: { minPrice: 30000, referencePrice: 50000, maxPrice: 80000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
        ],
      },
      {
        slug: 'batterie',
        name: 'Batterie défectueuse',
        description: 'Batterie qui se vide rapidement ou ne charge plus',
        diags: [
          {
            slug: 'remplacement-batterie',
            name: 'Remplacement batterie',
            description: "Remplacement de la batterie usée",
            difficulty: 'Facile',
            estimatedTime: '20-30 min',
            interventions: [
              {
                slug: 'remplacement-batterie-standard',
                name: "Remplacement batterie standard",
                description: "Batterie compatible de qualité",
                difficulty: 'Facile',
                estimatedTime: '20-30 min',
                needsParts: true,
                partsNote: 'Batterie compatible',
                pricing: { minPrice: 8000, referencePrice: 15000, maxPrice: 25000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
        ],
      },
      {
        slug: 'ne-charge-plus',
        name: 'Ne charge plus',
        description: 'Le téléphone ne recharge pas ou mal',
        diags: [
          {
            slug: 'connecteur-charge',
            name: 'Connecteur de charge endommagé',
            description: 'Le connecteur USB-C ou Lightning est défectueux',
            difficulty: 'Moyen',
            estimatedTime: '30-60 min',
            interventions: [
              {
                slug: 'remplacement-connecteur',
                name: "Remplacement connecteur de charge",
                description: "Remplacement du connecteur de charge",
                difficulty: 'Moyen',
                estimatedTime: '30-45 min',
                needsParts: true,
                partsNote: 'Connecteur compatible',
                pricing: { minPrice: 10000, referencePrice: 15000, maxPrice: 30000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
          {
            slug: 'circuit-charge',
            name: 'Circuit de charge défectueux',
            description: 'Problème de carte mère sur le circuit de charge',
            difficulty: 'Difficile',
            estimatedTime: '1-2h',
            interventions: [
              {
                slug: 'reparation-circuit-charge',
                name: "Réparation circuit de charge",
                description: "Réparation du circuit de charge sur carte mère",
                difficulty: 'Difficile',
                estimatedTime: '1-2h',
                needsParts: true,
                partsNote: 'Composants micro-soudure',
                pricing: { minPrice: 20000, referencePrice: 35000, maxPrice: 55000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
        ],
      },
      {
        slug: 'ne-demarre-plus',
        name: "Ne s'allume plus",
        description: "Le téléphone ne s'allume plus du tout",
        diags: [
          {
            slug: 'diag-ne-demarre-plus',
            name: "Diagnostic démarrage",
            description: "Diagnostic du problème de démarrage",
            difficulty: 'Moyen',
            estimatedTime: '30 min',
            interventions: [
              {
                slug: 'reboot-force-reset',
                name: "Reset forcé / reboot",
                description: "Tentative de reset forcé",
                difficulty: 'Facile',
                estimatedTime: '15 min',
                needsParts: false,
                partsNote: null,
                pricing: { minPrice: 3000, referencePrice: 5000, maxPrice: 8000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
        ],
      },
      {
        slug: 'camera',
        name: 'Caméra défectueuse',
        description: 'La caméra ne fonctionne plus ou images floues',
        diags: [
          {
            slug: 'remplacement-camera',
            name: 'Remplacement caméra',
            description: "Remplacement du module caméra",
            difficulty: 'Moyen',
            estimatedTime: '30-45 min',
            interventions: [
              {
                slug: 'remplacement-camera-arriere',
                name: "Remplacement caméra arrière",
                description: "Remplacement du module caméra arrière",
                difficulty: 'Moyen',
                estimatedTime: '30-45 min',
                needsParts: true,
                partsNote: 'Module caméra compatible',
                pricing: { minPrice: 12000, referencePrice: 22000, maxPrice: 40000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
        ],
      },
      {
        slug: 'microphone',
        name: 'Microphone défectueux',
        description: "L'interlocuteur n'entend pas ou mal",
        diags: [
          {
            slug: 'remplacement-microphone',
            name: 'Remplacement microphone',
            description: "Remplacement du microphone",
            difficulty: 'Moyen',
            estimatedTime: '30-45 min',
            interventions: [
              {
                slug: 'remplacement-micro',
                name: "Remplacement microphone",
                description: "Remplacement du module microphone",
                difficulty: 'Moyen',
                estimatedTime: '30-45 min',
                needsParts: true,
                partsNote: 'Module microphone compatible',
                pricing: { minPrice: 8000, referencePrice: 15000, maxPrice: 25000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
        ],
      },
      {
        slug: 'haut-parleur',
        name: 'Haut-parleur défectueux',
        description: 'Son faible ou absent du haut-parleur',
        diags: [
          {
            slug: 'remangement-haut-parleur',
            name: 'Remplacement haut-parleur',
            description: "Remplacement du haut-parleur",
            difficulty: 'Moyen',
            estimatedTime: '30-45 min',
            interventions: [
              {
                slug: 'remplacement-hp',
                name: "Remplacement haut-parleur",
                description: "Remplacement du module haut-parleur",
                difficulty: 'Moyen',
                estimatedTime: '30-45 min',
                needsParts: true,
                partsNote: 'Module haut-parleur compatible',
                pricing: { minPrice: 8000, referencePrice: 15000, maxPrice: 25000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
        ],
      },
      {
        slug: 'vitre-arriere',
        name: 'Vitre arrière cassée',
        description: 'La vitre arrière est fissurée ou brisée',
        diags: [
          {
            slug: 'remplacement-vitre',
            name: 'Remplacement vitre arrière',
            description: "Remplacement de la vitre arrière",
            difficulty: 'Moyen',
            estimatedTime: '30-60 min',
            interventions: [
              {
                slug: 'remplacement-vitre-arriere',
                name: "Remplacement vitre arrière",
                description: "Remplacement de la vitre arrière",
                difficulty: 'Moyen',
                estimatedTime: '30-60 min',
                needsParts: true,
                partsNote: 'Vitre compatible',
                pricing: { minPrice: 10000, referencePrice: 18000, maxPrice: 30000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
        ],
      },
      {
        slug: 'logiciel',
        name: 'Problème logiciel',
        description: 'Bugs, ralentissements, applications qui plantent',
        diags: [
          {
            slug: 'diag-logiciel',
            name: 'Diagnostic logiciel',
            description: "Diagnostic et réparation logicielle",
            difficulty: 'Facile',
            estimatedTime: '30-60 min',
            interventions: [
              {
                slug: 'reset-usine',
                name: "Reset usine / réinstall",
                description: "Réinitialisation en usine ou réinstallation du système",
                difficulty: 'Facile',
                estimatedTime: '30-60 min',
                needsParts: false,
                partsNote: null,
                pricing: { minPrice: 5000, referencePrice: 10000, maxPrice: 15000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
        ],
      },
      {
        slug: 'surchauffe',
        name: 'Surchauffe',
        description: 'Le téléphone chauffe anormalement',
        diags: [
          {
            slug: 'diag-surchauffe',
            name: 'Diagnostic surchauffe',
            description: "Diagnostic de la cause de surchauffe",
            difficulty: 'Moyen',
            estimatedTime: '30 min',
            interventions: [
              {
                slug: 'nettoyage-pate-thermique',
                name: "Nettoyage + pâte thermique",
                description: "Nettoyage interne et remise de pâte thermique",
                difficulty: 'Moyen',
                estimatedTime: '30-45 min',
                needsParts: false,
                partsNote: null,
                pricing: { minPrice: 8000, referencePrice: 12000, maxPrice: 18000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
        ],
      },
    ];

    let problemSort = 0;
    for (const p of problems) {
      const problem = await this.prisma.problem.upsert({
        where: { domainId_slug: { domainId, slug: p.slug } },
        create: {
          domainId,
          name: p.name,
          slug: p.slug,
          description: p.description,
          sortOrder: problemSort++,
        },
        update: { name: p.name, sortOrder: problemSort++ },
      });

      let diagSort = 0;
      for (const d of p.diags) {
        const diagnostic = await this.prisma.catalogDiagnostic.upsert({
          where: { problemId_slug: { problemId: problem.id, slug: d.slug } },
          create: {
            problemId: problem.id,
            name: d.name,
            slug: d.slug,
            description: d.description,
            difficulty: d.difficulty,
            estimatedTime: d.estimatedTime,
            sortOrder: diagSort++,
          },
          update: { name: d.name, sortOrder: diagSort++ },
        });

        let intervSort = 0;
        for (const i of d.interventions) {
          const intervention = await this.prisma.catalogIntervention.upsert({
            where: { diagnosticId_slug: { diagnosticId: diagnostic.id, slug: i.slug } },
            create: {
              diagnosticId: diagnostic.id,
              name: i.name,
              slug: i.slug,
              description: i.description,
              difficulty: i.difficulty,
              estimatedTime: i.estimatedTime,
              needsParts: i.needsParts,
              partsNote: i.partsNote ?? null,
              sortOrder: intervSort++,
            },
            update: { name: i.name, sortOrder: intervSort++ },
          });

          if (i.pricing) {
            // update: {} = pas d'écrasement des prix existants, préservant
            // les ajustements manuels de l'admin.
            await this.prisma.pricing.upsert({
              where: { interventionId: intervention.id },
              create: {
                interventionId: intervention.id,
                minPrice: i.pricing.minPrice,
                referencePrice: i.pricing.referencePrice,
                maxPrice: i.pricing.maxPrice,
                travelFee: i.pricing.travelFee,
                serviceFee: i.pricing.serviceFee,
                currency: 'XAF',
                priceMode: 'range',
              },
              update: {},
            });
          }
        }
      }
    }

    return {
      message: 'Domaine Smartphone vérifié.',
      domainId,
      problemsCount: problems.length,
    };
  }
}
