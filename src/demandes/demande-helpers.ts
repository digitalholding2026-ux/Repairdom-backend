/* Helpers purs des demandes — MODULE FEUILLE (aucune dépendance de service).
 *
 * Extraits de `demandes.service.ts` (correctif boucle circulaire DISPATCH-V1) :
 * `dispatch.service.ts` et `technician.service.ts` ont besoin de ces fonctions
 * pures (`isMatchingStatus`, `labelForCategory`, sérialisation API, priorité)
 * sans importer le `DemandesService` injectable. Importer un fichier qui
 * définit un `@Injectable()` crée une arête ESM d'exécution
 * (`demandes.service.js` ↔ `dispatch.service.js`) qui place `DispatchService`
 * en zone morte temporelle au démarrage :
 * `ReferenceError: Cannot access 'DispatchService' before initialization`.
 *
 * Ce module ne dépend d'AUCUN service (ni Prisma, ni Nest injectable, ni
 * Dispatch/Technician/Demandes) : le graphe redevient
 * `DemandesService → DispatchService → Prisma`, sans retour.
 *
 * Les fonctions sont COPIÉES À L'IDENTIQUE (aucun changement métier) ;
 * `demandes.service.ts` les ré-exporte pour compatibilité des imports
 * existants (tests, tracking, technicien).
 */

import { BadRequestException } from '@nestjs/common';
import { ALLOWED_CATEGORIES } from './categories.js';

export type DemandeCategory = (typeof ALLOWED_CATEGORIES)[number];

export interface DemandeTechnicianInfo {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  city: string | null;
}

export interface DemandeMediaRow {
  id: string;
  kind: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  stored: boolean;
}

export interface DemandeRecord {
  id: string;
  reference: string;
  status: string;
  category: string;
  description: string;
  city: string;
  // Sprint 8.8.2 — références structurées (null en transition/historique).
  // `zoneRef` reprend le nom exact de la relation Prisma (`Demande.zoneRef`) ;
  // l'API continue d'exposer le champ `zone` (aucun changement frontend).
  cityId: string | null;
  zoneId: string | null;
  zoneRef?: { id: string; name: string; slug: string; cityId: string } | null;
  cityRef?: { id: string; name: string; slug: string } | null;
  neighborhood: string | null;
  address: string | null;
  landmark: string | null;
  contactPhone: string | null;
  clientId: string;
  technicianId: string | null;
  scheduledAt: Date | null;
  requestedMode: string;
  requestedAt: Date | null;
  createdAt: Date;
  domainId: string | null;
  brandId: string | null;
  modelId: string | null;
  problemId: string | null;
  negotiationRequestedAt: Date | null;
  finalAmount: number | null;
  medias: DemandeMediaRow[];
  technician?: DemandeTechnicianInfo | null;
  domain?: { id: string; name: string; slug: string } | null;
  brand?: { id: string; name: string; slug: string } | null;
  model?: { id: string; name: string; slug: string } | null;
  problem?: { id: string; name: string; slug: string } | null;
}

export function toApiDemande(demande: DemandeRecord) {
  return {
    id: demande.id,
    reference: demande.reference,
    status: demande.status,
    categoryId: demande.category,
    categoryLabel: labelForCategory(demande.category),
    description: demande.description,
    city: demande.city,
    // Sprint 8.8.2 — exposition additive (le frontend lit id/name ; le
    // détail précis reste protégé par `toApiDemandePublic`, inchangé).
    cityId: demande.cityId ?? null,
    zoneId: demande.zoneId ?? null,
    zone: demande.zoneRef ?? null,
    cityRef: demande.cityRef ?? null,
    neighborhood: demande.neighborhood,
    address: demande.address,
    landmark: demande.landmark,
    contactPhone: demande.contactPhone,
    technicianId: demande.technicianId,
    technician: demande.technician ?? null,
    scheduledAt: demande.scheduledAt ? demande.scheduledAt.toISOString() : null,
    requestedMode: demande.requestedMode,
    requestedAt: demande.requestedAt ? demande.requestedAt.toISOString() : null,
    domain: demande.domain
      ? { id: demande.domain.id, name: demande.domain.name, slug: demande.domain.slug }
      : null,
    brand: demande.brand
      ? { id: demande.brand.id, name: demande.brand.name, slug: demande.brand.slug }
      : null,
    model: demande.model
      ? { id: demande.model.id, name: demande.model.name, slug: demande.model.slug }
      : null,
    problem: demande.problem
      ? { id: demande.problem.id, name: demande.problem.name, slug: demande.problem.slug }
      : null,
    negotiationRequestedAt: demande.negotiationRequestedAt
      ? demande.negotiationRequestedAt.toISOString()
      : null,
    finalAmount: demande.finalAmount,
    medias: demande.medias.map((media) => ({
      id: media.id,
      kind: media.kind,
      name: media.fileName,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      stored: media.stored,
    })),
    mediaPersisted: false,
    storageStatus: 'metadata-only',
    createdAt: demande.createdAt.toISOString(),
  };
}

// Sérialisation publique (opportunités) : aucun détail privé (adresse,
// contact téléphonique) n'est exposé tant que le technicien n'est pas assigné.
export function toApiDemandePublic(demande: DemandeRecord) {
  const api = toApiDemande(demande);
  return {
    ...api,
    neighborhood: null,
    address: null,
    landmark: null,
    contactPhone: null,
  };
}

export function hasCategory(category: string): category is DemandeCategory {
  return (ALLOWED_CATEGORIES as readonly string[]).includes(category);
}

export function isMatchingStatus(status: string): status is 'SUBMITTED' | 'PENDING' {
  return status === 'SUBMITTED' || status === 'PENDING';
}

export function isAsapMode(mode: string): boolean {
  return mode === 'ASAP';
}

/* Priorité d'affichage des opportunités (préservée à l'identique) :
 * « dès que possible » d'abord, puis plus récent d'abord. Extraite en
 * fonction pure et partagée pour testabilité (recherche technicien). */
export function compareDemandePriority(
  a: { requestedMode: string; createdAt: Date },
  b: { requestedMode: string; createdAt: Date },
): number {
  const aAsap = isAsapMode(a.requestedMode);
  const bAsap = isAsapMode(b.requestedMode);
  if (aAsap !== bAsap) return aAsap ? -1 : 1;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

export function resolveRequestedAt(mode: string, requestedAt?: string): Date | null {
  if (mode === 'SCHEDULED') {
    if (!requestedAt) {
      throw new BadRequestException(
        'Veuillez préciser la date et l\'heure auxquelles vous souhaitez être dépanné.',
      );
    }
    const date = new Date(requestedAt);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('La date d\'intervention souhaitée est invalide.');
    }
    if (date.getTime() <= Date.now()) {
      throw new BadRequestException(
        'La date d\'intervention souhaitée ne peut pas être dans le passé.',
      );
    }
    return date;
  }

  if (requestedAt) {
    throw new BadRequestException(
      'Une intervention « dès que possible » ne doit pas comporter de date souhaitée.',
    );
  }
  return null;
}

export function labelForCategory(category: string): string {
  const labels: Record<string, string> = {
    electricite: 'Électricité',
    plomberie: 'Plomberie',
    climatisation: 'Climatisation',
    electromenager: 'Électroménager',
    serrurerie: 'Serrurerie',
    informatique: 'Informatique',
    autre: 'Autre',
  };
  return labels[category] ?? category;
}
