/* GPS V1 — calcul local de distance géographique (Haversine).
 *
 * Pur, déterministe, sans appel externe : distance entre une demande et la
 * dernière position connue d'un technicien, exploitable plus tard par le
 * dispatch (qui reste inchangé en V1 : city/zone/category).
 * Résultat en mètres (entier arrondi), jamais NaN/Infinity ; `null` si une
 * coordonnée est absente ou invalide. */

export interface GpsCoordinates {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_METERS = 6371000;

/* GPS V2 — fraîcheur d'une position : la transmission est manuelle et
 * ponctuelle (bouton « Mettre à jour ma position »), pas du tracking.
 * 24 h couvre un cycle de journée de travail : un technicien qui transmet
 * le matin reste exploitable toute la journée ; au-delà, la position est
 * considérée périmée (GPS_STALE : candidat SANS distance, jamais exclu). */
export const GPS_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/** Vrai si `locationUpdatedAt` est présent, passé et vieux d'au plus la
 *  fenêtre de fraîcheur (jamais d'exception, jamais de futur accepté). */
export function isLocationFresh(
  locationUpdatedAt: Date | string | null | undefined,
  now: Date = new Date(),
  freshnessMs: number = GPS_FRESHNESS_MS,
): boolean {
  if (locationUpdatedAt === null || locationUpdatedAt === undefined) return false;
  const updatedTime =
    locationUpdatedAt instanceof Date
      ? locationUpdatedAt.getTime()
      : Date.parse(locationUpdatedAt);
  if (!Number.isFinite(updatedTime)) return false;
  const nowTime = now.getTime();
  return updatedTime <= nowTime && nowTime - updatedTime <= freshnessMs;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function isValidLatitude(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= -90 &&
    value <= 90
  );
}

export function isValidLongitude(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= -180 &&
    value <= 180
  );
}

export function isValidCoordinates(value: unknown): value is GpsCoordinates {
  if (!value || typeof value !== 'object') return false;
  const { latitude, longitude } = value as Record<string, unknown>;
  return isValidLatitude(latitude) && isValidLongitude(longitude);
}

/** Distance Haversine en mètres (entier ≥ 0), `null` si entrée invalide. */
export function haversineMeters(
  from: GpsCoordinates | null | undefined,
  to: GpsCoordinates | null | undefined,
): number | null {
  if (!isValidCoordinates(from) || !isValidCoordinates(to)) return null;
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLng = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const clamped = Math.min(1, Math.max(0, a));
  const distance = 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(clamped));
  if (!Number.isFinite(distance) || distance < 0) return null;
  return Math.round(distance);
}

interface LocatedDemande {
  latitude: number | null;
  longitude: number | null;
}

interface LocatedTechnician {
  lastLatitude: number | null;
  lastLongitude: number | null;
}

/** Distance demande ↔ dernière position technicien (mètres), `null` si
 *  l'une des deux positions est absente. Utilisé en lecture seule (jamais
 *  dans le matching V1). */
export function demandeTechnicianDistanceMeters(
  demande: LocatedDemande | null | undefined,
  technician: LocatedTechnician | null | undefined,
): number | null {
  if (!demande || !technician) return null;
  if (
    demande.latitude === null ||
    demande.latitude === undefined ||
    demande.longitude === null ||
    demande.longitude === undefined ||
    technician.lastLatitude === null ||
    technician.lastLatitude === undefined ||
    technician.lastLongitude === null ||
    technician.lastLongitude === undefined
  ) {
    return null;
  }
  return haversineMeters(
    { latitude: demande.latitude, longitude: demande.longitude },
    { latitude: technician.lastLatitude, longitude: technician.lastLongitude },
  );
}
