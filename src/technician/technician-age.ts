/**
 * Calcul d'âge exact et contrôle de majorité.
 *
 * RÈGLE ABSOLUE : ne jamais faire `année courante - année de naissance`.
 * On compare le mois puis le jour, ce qui gère correctement :
 *   - un anniversaire non encore passé cette année (ex. 2008-12-31 au 04/10) ;
 *   - le 29 février (28/02 en année non bissextile = veille de l'anniversaire).
 *
 * L'âge est calculé sur la date COMPLETE (jour + mois + année), en heure
 * locale, et non sur un entier d'annéesApproximatif.
 */

/** Âge révolu à la date de référence. Date invalide -> `null`. */
export function computeAge(birthDate: Date, now: Date = new Date()): number | null {
  const birth = toUtcDateOnly(birthDate);
  const today = toUtcDateOnly(now);
  if (birth === null || today === null) return null;

  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = today.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

/** Vrai si l'âge révolu atteint `minimumAge`. */
export function isAtLeastAge(
  birthDate: Date | null | undefined,
  minimumAge: number,
  now: Date = new Date(),
): boolean {
  if (!birthDate) return false;
  const age = computeAge(birthDate, now);
  return age !== null && age >= minimumAge;
}

/** Âge minimal pour exercer comme technicien sur Relio. */
export const TECHNICIAN_MINIMUM_AGE = 18;

/** Message métier unique, réutilisé par le profil et le backoffice. */
export const TECHNICIAN_MINIMUM_AGE_MESSAGE =
  'Vous devez avoir au moins 18 ans pour exercer comme technicien sur Relio.';

/**
 * Normalise une date de naissance saisie par un client en `Date` UTC-minuit.
 * Accepte `YYYY-MM-DD` (input `type="date"`) ou un `Date` déjà valide.
 * Refuse les dates impossibles (31 février) et les années aberrantes.
 */
export function parseBirthDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : toUtcDateOnly(value);
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > new Date().getUTCFullYear()) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Rejette le débordement (31/02 -> 03/03) en comparant les parties.
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return candidate;
}

/** Tronque une date à sa partie UTC (jour/mois/année), sans heure ni fuseau. */
function toUtcDateOnly(value: Date | null | undefined): Date | null {
  if (!value) return null;
  const time = value.getTime();
  if (Number.isNaN(time)) return null;
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}