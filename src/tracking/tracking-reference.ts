/* CHANTIER NAVIGATION P1/P2 — référence publique de suivi (`RD-XXXXXX`).
 *
 * Alphabet de génération (`demandes.service.ts#REFERENCE_ALPHABET`,
 * 32 symboles, 6 positions ≈ 1 milliard de combinaisons) : l'énumération
 * exhaustive est impraticable, mais un throttle + une validation stricte
 * du format (400 avant toute requête DB) réduisent le balayage robotisé
 * sans demander d'authentification (le suivi public reste anonyme). */

/** Alphabet exact des références générées (sans I ni O, chiffres 0-9). */
export const TRACKING_REFERENCE_PATTERN = /^RD-[A-HJ-NP-Z0-9]{6}$/;

/** Vrai si la référence a le format public exact (insensible à la casse
 *  et aux espaces autour, jamais d'exception). */
export function isValidTrackingReference(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return TRACKING_REFERENCE_PATTERN.test(value.trim().toUpperCase());
}
