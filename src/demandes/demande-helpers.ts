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
import {
  GPS_TRAVEL_FRESHNESS_MS,
  haversineMeters,
  isLocationFresh,
  minutesSince,
} from '../geo/geo-distance.js';

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
  // GPS V1 — nullable (demandes historiques sans GPS).
  latitude: number | null;
  longitude: number | null;
  // GPS V3 — déplacement temporaire (tous NULLABLES, détail uniquement).
  travelLatitude?: number | null;
  travelLongitude?: number | null;
  travelLocationUpdatedAt?: Date | null;
  technicianEnRouteAt?: Date | null;
  technicianArrivedAt?: Date | null;
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
    // GPS V1 — exposé aux contextes propriétaires/assignés ; neutralisé
    // dans `toApiDemandePublic` (opportunités non assignées).
    latitude: demande.latitude ?? null,
    longitude: demande.longitude ?? null,
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
// contact téléphonique, GPS) n'est exposé tant que le technicien n'est pas
// assigné.
export function toApiDemandePublic(demande: DemandeRecord) {
  const api = toApiDemande(demande);
  return {
    ...api,
    neighborhood: null,
    address: null,
    landmark: null,
    contactPhone: null,
    latitude: null,
    longitude: null,
  };
}

/* GPS V3 — vues de déplacement (jamais d'historique, jamais de tracking).
 *
 * Vue TECHNICIEN (mission assignée, propriétaire des données) : coordonnées
 * de déplacement + fraîcheur + distance au lieu d'intervention (mètres,
 * null si indisponible — jamais 0 forcé).
 *
 * Vue CLIENT (client de LA mission uniquement) : mêmes informations SANS
 * les coordonnées brutes (jamais exposées) ; `fresh` + `minutesSinceUpdate`
 * permettent l'affichage « il y a X min » / « momentanément indisponible ».
 *
 * Les deux vues partagent : `enRoute` (déplacement actif : démarré ET non
 * arrivé), `arrived` (déplacement clos), horodatages ISO.
 * La distance n'est calculée que sur position FRAÎCHE (fenêtre V3) :
 * une position périmée ne produit jamais de distance « actuelle ». */

export interface TravelTechnicianView {
  enRoute: boolean;
  arrived: boolean;
  enRouteAt: string | null;
  arrivedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  locationUpdatedAt: string | null;
  fresh: boolean;
  minutesSinceUpdate: number | null;
  distanceMeters: number | null;
}

export interface TravelClientView {
  enRoute: boolean;
  arrived: boolean;
  enRouteAt: string | null;
  arrivedAt: string | null;
  locationUpdatedAt: string | null;
  fresh: boolean;
  minutesSinceUpdate: number | null;
  distanceMeters: number | null;
}

interface TravelSource {
  latitude: number | null;
  longitude: number | null;
  travelLatitude?: number | null;
  travelLongitude?: number | null;
  travelLocationUpdatedAt?: Date | string | null;
  technicianEnRouteAt?: Date | string | null;
  technicianArrivedAt?: Date | string | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return value.toISOString();
}

function travelBase(demande: TravelSource, now: Date) {
  const enRouteAt = demande.technicianEnRouteAt ?? null;
  const arrivedAt = demande.technicianArrivedAt ?? null;
  const locationUpdatedAt = demande.travelLocationUpdatedAt ?? null;
  const arrived = arrivedAt !== null && arrivedAt !== undefined;
  const enRoute =
    enRouteAt !== null && enRouteAt !== undefined && !arrived;
  const fresh =
    enRoute &&
    isLocationFresh(locationUpdatedAt, now, GPS_TRAVEL_FRESHNESS_MS);
  const minutes = minutesSince(
    locationUpdatedAt instanceof Date || typeof locationUpdatedAt === 'string'
      ? locationUpdatedAt
      : null,
    now,
  );
  // Distance uniquement sur position fraîche (jamais de 0 forcé).
  const distanceMeters = fresh
    ? haversineMeters(
        demande.latitude === null || demande.latitude === undefined ||
          demande.longitude === null || demande.longitude === undefined
          ? null
          : { latitude: demande.latitude, longitude: demande.longitude },
        demande.travelLatitude === null || demande.travelLatitude === undefined ||
          demande.travelLongitude === null || demande.travelLongitude === undefined
          ? null
          : { latitude: demande.travelLatitude, longitude: demande.travelLongitude },
      )
    : null;
  return {
    enRoute,
    arrived,
    enRouteAt: toIso(enRouteAt),
    arrivedAt: toIso(arrivedAt),
    locationUpdatedAt: toIso(locationUpdatedAt),
    fresh,
    minutesSinceUpdate: minutes,
    distanceMeters,
  };
}

export function toApiTravelTechnician(
  demande: TravelSource,
  now: Date = new Date(),
): TravelTechnicianView {
  return {
    ...travelBase(demande, now),
    latitude: demande.travelLatitude ?? null,
    longitude: demande.travelLongitude ?? null,
  };
}

export function toApiTravelClient(
  demande: TravelSource,
  now: Date = new Date(),
): TravelClientView {
  return travelBase(demande, now);
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
