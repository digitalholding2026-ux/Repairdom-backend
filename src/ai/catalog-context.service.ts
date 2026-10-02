import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/* Catalogue source de vérité IA (contexte dynamique, jamais d'entraînement).
 *
 * PostgreSQL reste l'autorité : ce service ne fait que SÉLECTIONNER le
 * contexte pertinent (borné, actif uniquement) pour les services IA existants
 * (IA-4/IA-5/IA-6/IA-8 via AiGatewayService). L'IA propose, le backend vérifie
 * l'existence réelle en base et applique les règles métier (prix via
 * comparePriceToScale, jamais calculé par le modèle).
 *
 * Correspondance métier : Catalogue=ServiceDomain, Spécification=DeviceBrand,
 * Modèle=DeviceModel, Catégorie=Problem, Tarification=Pricing (min/ref/max).
 */

export interface CatalogModelCandidate {
  id: string;
  name: string;
  brandId: string;
  brandName: string;
  domainId: string;
  domainName: string;
}

export interface CatalogScale {
  min: number | null;
  reference: number | null;
  max: number | null;
  currency: string;
  pricingIds: string[];
  pricedInterventions: number;
}

export interface DemandeCatalogContext {
  catalogueId: string | null;
  catalogueName: string | null;
  specificationId: string | null;
  specificationName: string | null;
  modelId: string | null;
  modelName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  scale: CatalogScale | null;
  source: 'DEMANDE' | 'NONE';
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokensOf(text: string): string[] {
  const n = normalize(text);
  if (!n) return [];
  return n.split(' ').filter((t) => t.length >= 3);
}

@Injectable()
export class CatalogContextService {
  constructor(private readonly prisma: PrismaService) {}

  /* Recherche ciblée de modèles actifs (jamais tout le catalogue à l'IA).
   * Score déterministe par recouvrement de tokens ; borné (défaut 5). */
  async searchModels(query: string, limit = 5): Promise<CatalogModelCandidate[]> {
    const tokens = tokensOf(query);
    if (tokens.length === 0) return [];
    const bounded = Math.min(Math.max(limit, 1), 10);
    const models = await this.prisma.deviceModel.findMany({
      where: { isActive: true, brand: { isActive: true, domain: { isActive: true } } },
      take: 300,
      orderBy: [{ name: 'asc' }],
      select: {
        id: true,
        name: true,
        brand: { select: { id: true, name: true, domain: { select: { id: true, name: true } } } },
      },
    });
    const scored = models
      .map((m) => {
        const hay = normalize(`${m.name} ${m.brand.name} ${m.brand.domain.name}`);
        let score = 0;
        for (const t of tokens) {
          if (hay.includes(t)) score += t.length >= 5 ? 2 : 1;
        }
        // Bonus : le nom du modèle contient presque toute la requête.
        if (tokens.length >= 2 && tokens.every((t) => hay.includes(t))) score += 3;
        return { m, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, bounded);
    return scored.map((s) => ({
      id: s.m.id,
      name: s.m.name,
      brandId: s.m.brand.id,
      brandName: s.m.brand.name,
      domainId: s.m.brand.domain.id,
      domainName: s.m.brand.domain.name,
    }));
  }

  /* Vérification backend d'un ID proposé par l'IA : existe + actif.
   * Inconnu/inactif → null (UNCERTAIN/UNMATCHED, jamais bloquant). */
  async verifyModel(modelId: string): Promise<CatalogModelCandidate | null> {
    const m = await this.prisma.deviceModel.findUnique({
      where: { id: modelId },
      select: {
        id: true,
        name: true,
        isActive: true,
        brand: {
          select: {
            id: true,
            name: true,
            isActive: true,
            domain: { select: { id: true, name: true, isActive: true } },
          },
        },
      },
    });
    if (!m || !m.isActive || !m.brand.isActive || !m.brand.domain.isActive) return null;
    return {
      id: m.id,
      name: m.name,
      brandId: m.brand.id,
      brandName: m.brand.name,
      domainId: m.brand.domain.id,
      domainName: m.brand.domain.name,
    };
  }

  /* Catégories actives d'un modèle précis (prioritaire pour IA-5). */
  async getModelCategories(modelId: string): Promise<Array<{ id: string; name: string; slug: string }>> {
    const verified = await this.prisma.deviceModel.findUnique({
      where: { id: modelId },
      select: { id: true, isActive: true },
    });
    if (!verified || !verified.isActive) return [];
    return this.prisma.problem.findMany({
      where: { modelId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true },
    });
  }

  /* Barème backend exact (MODÈLE + CATÉGORIE) : agrégation des pricings
   * ACTIFS des interventions ACTIVES des diagnostics ACTIFS. Le prix ne vient
   * jamais de l'IA : ce sont ces valeurs qui alimentent IA-6/IA-8. */
  async getScaleForModelCategory(modelId: string, problemId: string): Promise<CatalogScale | null> {
    const problem = await this.prisma.problem.findUnique({
      where: { id: problemId },
      select: {
        id: true,
        modelId: true,
        isActive: true,
        diagnostics: {
          where: { isActive: true },
          select: { interventions: { where: { isActive: true }, select: { pricing: true } } },
        },
      },
    });
    if (!problem || !problem.isActive || problem.modelId !== modelId) return null;
    const pricings = problem.diagnostics
      .flatMap((d) => d.interventions.map((i) => i.pricing))
      .filter((p): p is NonNullable<typeof p> => p !== null && p.isActive);
    if (pricings.length === 0) return null;
    const mins = pricings.map((p) => p.minPrice).filter((v): v is number => v !== null);
    const maxs = pricings.map((p) => p.maxPrice).filter((v): v is number => v !== null);
    const refs = [...new Set(pricings.map((p) => p.referencePrice).filter((v): v is number => v !== null))];
    return {
      min: mins.length > 0 ? Math.min(...mins) : null,
      reference: refs.length === 1 ? refs[0] : null,
      max: maxs.length > 0 ? Math.max(...maxs) : null,
      currency: 'XAF',
      pricingIds: pricings.map((p) => p.id),
      pricedInterventions: pricings.length,
    };
  }

  /* Contexte catalogue borné d'une demande : IDs (jamais de dump), barème
   * actuel récupéré à la demande. Utilisé par IA-5/IA-6/IA-8. */
  async buildDemandeCatalogContext(demandeId: string): Promise<DemandeCatalogContext> {
    const d = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: {
        domainId: true,
        brandId: true,
        modelId: true,
        problemId: true,
        domain: { select: { id: true, name: true, isActive: true } },
        brand: { select: { id: true, name: true, isActive: true } },
        model: { select: { id: true, name: true, isActive: true } },
        problem: { select: { id: true, name: true, isActive: true } },
      },
    });
    if (!d) return { catalogueId: null, catalogueName: null, specificationId: null, specificationName: null, modelId: null, modelName: null, categoryId: null, categoryName: null, scale: null, source: 'NONE' };
    const active = {
      domain: d.domain && d.domain.isActive ? d.domain : null,
      brand: d.brand && d.brand.isActive ? d.brand : null,
      model: d.model && d.model.isActive ? d.model : null,
      problem: d.problem && d.problem.isActive ? d.problem : null,
    };
    let scale: CatalogScale | null = null;
    if (d.modelId && d.problemId && active.model && active.problem) {
      scale = await this.getScaleForModelCategory(d.modelId, d.problemId);
    }
    const hasAny = !!(active.domain || active.brand || active.model || active.problem);
    return {
      catalogueId: active.domain?.id ?? null,
      catalogueName: active.domain?.name ?? null,
      specificationId: active.brand?.id ?? null,
      specificationName: active.brand?.name ?? null,
      modelId: active.model?.id ?? null,
      modelName: active.model?.name ?? null,
      categoryId: active.problem?.id ?? null,
      categoryName: active.problem?.name ?? null,
      scale,
      source: hasAny ? 'DEMANDE' : 'NONE',
    };
  }
}
