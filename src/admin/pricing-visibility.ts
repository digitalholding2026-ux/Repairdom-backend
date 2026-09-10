/* Politique de visibilité tarifaire RepairDom (Sprint 8 / 8.1).
 *
 * Un même Pricing ne doit JAMAIS être renvoyé brut à n'importe quel rôle :
 *  - ADMIN   : données internes complètes (min/max/historique).
 *  - technicien assigné : fourchette pour négocier (min/ref/max/frais).
 *  - client  : uniquement le prix de référence + frais de déplacement.
 * Les endpoints client/public ne doivent jamais exposer minPrice/maxPrice. */

export interface PricingRaw {
  id?: string;
  interventionId?: string;
  minPrice: number | null;
  referencePrice: number | null;
  maxPrice: number | null;
  travelFee: number | null;
  serviceFee: number | null;
  currency: string;
  priceMode: string;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  history?: Array<{
    id: string;
    pricingId: string;
    adminId: string;
    previousValues: unknown;
    newValues: unknown;
    reason: string | null;
    createdAt: Date;
  }>;
}

export function toAdminPricing(pricing: PricingRaw) {
  return {
    id: pricing.id,
    interventionId: pricing.interventionId,
    minPrice: pricing.minPrice,
    referencePrice: pricing.referencePrice,
    maxPrice: pricing.maxPrice,
    travelFee: pricing.travelFee,
    serviceFee: pricing.serviceFee,
    currency: pricing.currency,
    priceMode: pricing.priceMode,
    isActive: pricing.isActive,
    createdAt: pricing.createdAt,
    updatedAt: pricing.updatedAt,
    history: pricing.history ?? [],
  };
}

export function toTechnicianPricing(pricing: PricingRaw) {
  return {
    id: pricing.id,
    interventionId: pricing.interventionId,
    minPrice: pricing.minPrice,
    referencePrice: pricing.referencePrice,
    maxPrice: pricing.maxPrice,
    travelFee: pricing.travelFee,
    serviceFee: pricing.serviceFee,
    currency: pricing.currency,
    priceMode: pricing.priceMode,
  };
}

export function toClientPricing(pricing: PricingRaw) {
  return {
    referencePrice: pricing.referencePrice,
    travelFee: pricing.travelFee,
    currency: pricing.currency,
    priceMode: pricing.priceMode,
  };
}