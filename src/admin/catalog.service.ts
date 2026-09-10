import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
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
} from './dto/catalog.dto.js';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /* ── ServiceDomain ──────────────────────────────────────────── */

  async listDomains() {
    return this.prisma.serviceDomain.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { problems: true } } },
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
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  /* ── Problem ────────────────────────────────────────────────── */

  async listProblems(domainId: string) {
    const domain = await this.prisma.serviceDomain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domaine introuvable.');
    return this.prisma.problem.findMany({
      where: { domainId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { diagnostics: true } } },
    });
  }

  async getProblem(id: string) {
    const problem = await this.prisma.problem.findUnique({
      where: { id },
      include: {
        domain: true,
        diagnostics: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: { _count: { select: { interventions: true } } },
        },
      },
    });
    if (!problem) throw new NotFoundException('Problème introuvable.');
    return problem;
  }

  async createProblem(dto: CreateProblemDto) {
    const domain = await this.prisma.serviceDomain.findUnique({ where: { id: dto.domainId } });
    if (!domain) throw new NotFoundException('Domaine introuvable.');
    const slug = dto.slug.trim().toLowerCase();
    const existing = await this.prisma.problem.findFirst({
      where: { domainId: dto.domainId, slug },
    });
    if (existing) throw new BadRequestException('Ce slug existe déjà pour ce domaine.');
    return this.prisma.problem.create({
      data: {
        domainId: dto.domainId,
        name: dto.name.trim(),
        slug,
        description: dto.description?.trim() || null,
      },
    });
  }

  async updateProblem(id: string, dto: UpdateProblemDto) {
    const problem = await this.prisma.problem.findUnique({ where: { id } });
    if (!problem) throw new NotFoundException('Problème introuvable.');
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
    return diagnostic;
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
    return this.prisma.catalogIntervention.findMany({
      where: { diagnosticId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { pricing: true },
    });
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
    return intervention;
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
    return pricing;
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
        technicianPrice: dto.technicianPrice ?? null,
        customerPrice: dto.customerPrice ?? null,
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
      technicianPrice: pricing.technicianPrice,
      customerPrice: pricing.customerPrice,
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
    if (dto.technicianPrice !== undefined) newData.technicianPrice = dto.technicianPrice ?? null;
    if (dto.customerPrice !== undefined) newData.customerPrice = dto.customerPrice ?? null;
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
    if (existing) {
      return { message: 'Le domaine Smartphone existe déjà.', domainId: existing.id };
    }

    const domain = await this.prisma.serviceDomain.create({
      data: {
        name: 'Smartphone',
        slug: 'smartphone',
        description: 'Réparation et maintenance de smartphones',
        icon: 'smartphone',
      },
    });

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
                pricing: { minPrice: 15000, referencePrice: 25000, maxPrice: 40000, technicianPrice: 15000, customerPrice: 25000, travelFee: 2000, serviceFee: 3000 },
              },
              {
                slug: 'remplacement-ecran-premium',
                name: "Remplacement écran premium",
                description: "Remplacement écran OEM/original",
                difficulty: 'Moyen',
                estimatedTime: '45-60 min',
                needsParts: true,
                partsNote: 'Écran OEM ou original',
                pricing: { minPrice: 30000, referencePrice: 50000, maxPrice: 80000, technicianPrice: 20000, customerPrice: 50000, travelFee: 2000, serviceFee: 3000 },
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
                pricing: { minPrice: 8000, referencePrice: 15000, maxPrice: 25000, technicianPrice: 8000, customerPrice: 15000, travelFee: 2000, serviceFee: 3000 },
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
                pricing: { minPrice: 10000, referencePrice: 18000, maxPrice: 30000, technicianPrice: 10000, customerPrice: 18000, travelFee: 2000, serviceFee: 3000 },
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
                pricing: { minPrice: 20000, referencePrice: 35000, maxPrice: 55000, technicianPrice: 20000, customerPrice: 35000, travelFee: 2000, serviceFee: 3000 },
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
                pricing: { minPrice: 3000, referencePrice: 5000, maxPrice: 8000, technicianPrice: 3000, customerPrice: 5000, travelFee: 2000, serviceFee: 3000 },
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
                pricing: { minPrice: 12000, referencePrice: 22000, maxPrice: 40000, technicianPrice: 12000, customerPrice: 22000, travelFee: 2000, serviceFee: 3000 },
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
                pricing: { minPrice: 8000, referencePrice: 15000, maxPrice: 25000, technicianPrice: 8000, customerPrice: 15000, travelFee: 2000, serviceFee: 3000 },
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
                pricing: { minPrice: 8000, referencePrice: 15000, maxPrice: 25000, technicianPrice: 8000, customerPrice: 15000, travelFee: 2000, serviceFee: 3000 },
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
                pricing: { minPrice: 10000, referencePrice: 18000, maxPrice: 30000, technicianPrice: 10000, customerPrice: 18000, travelFee: 2000, serviceFee: 3000 },
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
                pricing: { minPrice: 5000, referencePrice: 10000, maxPrice: 15000, technicianPrice: 5000, customerPrice: 10000, travelFee: 2000, serviceFee: 3000 },
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
                pricing: { minPrice: 8000, referencePrice: 12000, maxPrice: 18000, technicianPrice: 8000, customerPrice: 12000, travelFee: 2000, serviceFee: 3000 },
              },
            ],
          },
        ],
      },
    ];

    let problemSort = 0;
    for (const p of problems) {
      const problem = await this.prisma.problem.create({
        data: {
          domainId: domain.id,
          name: p.name,
          slug: p.slug,
          description: p.description,
          sortOrder: problemSort++,
        },
      });

      let diagSort = 0;
      for (const d of p.diags) {
        const diagnostic = await this.prisma.catalogDiagnostic.create({
          data: {
            problemId: problem.id,
            name: d.name,
            slug: d.slug,
            description: d.description,
            difficulty: d.difficulty,
            estimatedTime: d.estimatedTime,
            sortOrder: diagSort++,
          },
        });

        let intervSort = 0;
        for (const i of d.interventions) {
          const intervention = await this.prisma.catalogIntervention.create({
            data: {
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
          });

          if (i.pricing) {
            await this.prisma.pricing.create({
              data: {
                interventionId: intervention.id,
                minPrice: i.pricing.minPrice,
                referencePrice: i.pricing.referencePrice,
                maxPrice: i.pricing.maxPrice,
                technicianPrice: i.pricing.technicianPrice,
                customerPrice: i.pricing.customerPrice,
                travelFee: i.pricing.travelFee,
                serviceFee: i.pricing.serviceFee,
                currency: 'XAF',
                priceMode: 'range',
              },
            });
          }
        }
      }
    }

    return {
      message: 'Domaine Smartphone créé avec succès.',
      domainId: domain.id,
      problemsCount: problems.length,
    };
  }
}
