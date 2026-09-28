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

/* GPS V3 — fraîcheur d'une position DE DÉPLACEMENT (« technicien en
 * route ») : 15 minutes. Même principe que V2 (`isLocationFresh` avec
 * fenêtre paramétrable), mais fenêtre courte adaptée au déplacement en
 * cours : au-delà, la position n'est plus présentée comme actuelle
 * (« dernière mise à jour il y a X min »), jamais inventée. */
export const GPS_TRAVEL_FRESHNESS_MS = 15 * 60 * 1000;

/* CHANTIER GPS P0/P1 — seuil d'exploitabilité d'un fix de déplacement
 * (mètres, valeur `accuracy` fournie par le navigateur) : au-delà, le fix
 * est trop imprécis pour être présenté comme une localisation précise
 * (ex. 2 km). Il n'est jamais stocké comme position « fraîche » ; l'action
 * métier (« En route ») reste possible SANS position exploitable. `null` /
 * `undefined` (navigateur muet, ancien client) = exploitable par
 * compatibilité (les bornes lat/lng restent exigées). */
export const GPS_TRAVEL_MAX_ACCURACY_M = 500;

/* CHANTIER GPS P0/P1 — throttle du refresh manuel de position de
 * déplacement : deux écritures à moins de 30 s d'intervalle sont
 * considérées comme du spam (double-clic, retry agressif). Le backend
 * renvoie alors l'état courant SANS écrire (aucun background tracking,
 * aucun cron, actualisation manuelle préservée au-delà du délai). */
export const GPS_TRAVEL_REFRESH_THROTTLE_MS = 30_000;

/** Vrai si une `accuracy` navigateur est exploitable comme localisation
 *  précise (jamais inventée : `null`/`undefined` = information absente,
 *  traitée comme exploitable par compatibilité). */
export function isUsableTravelAccuracy(accuracy: number | null | undefined): boolean {
  if (accuracy === null || accuracy === undefined) return true;
  return (
    typeof accuracy === 'number' &&
    Number.isFinite(accuracy) &&
    accuracy >= 0 &&
    accuracy <= GPS_TRAVEL_MAX_ACCURACY_M
  );
}

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
export function demandeTechnicianDistanceMeters(  demande: LocatedDemande | null | undefined,
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

/* GPS V3 — minutes entières écoulées depuis `at` (0 si futur ou invalide
 * exclu : retourne `null` si l'horodatage est absent ou illisible). */
export function minutesSince(
  at: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (at === null || at === undefined) return null;
  const time = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(time)) return null;
  const diff = now.getTime() - time;
  if (diff < 0) return null;
  return Math.floor(diff / 60000);
}

/** Distance lieu d'intervention ↔ position de déplacement (mètres),
 *  `null` si l'une des deux positions est absente ou invalide. Jamais
 *  de valeur de remplacement (notamment jamais `0 km` forcé). */
export function travelDistanceMeters(
  demande: LocatedDemande | null | undefined,
  travel: { travelLatitude: number | null; travelLongitude: number | null } | null | undefined,
): number | null {
  if (!demande || !travel) return null;
  if (
    demande.latitude === null ||
    demande.latitude === undefined ||
    demande.longitude === null ||
    demande.longitude === undefined ||
    travel.travelLatitude === null ||
    travel.travelLatitude === undefined ||
    travel.travelLongitude === null ||
    travel.travelLongitude === undefined
  ) {
    return null;
  }
  return haversineMeters(
    { latitude: demande.latitude, longitude: demande.longitude },
    { latitude: travel.travelLatitude, longitude: travel.travelLongitude },
  );
}
