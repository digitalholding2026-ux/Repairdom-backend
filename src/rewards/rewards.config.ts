/**
 * Chantier 4-FONDATIONS-C — Programme de fidélité LTV : SEULE SOURCE DE VÉRITÉ
 * des seuils.
 *
 * Ce fichier ne contient QUE de la donnée et des règles pures : pas de Prisma,
 * pas de Nest, pas d'E/S. Il est donc testable directement (vitest) et
 * importable aussi bien par le service que par les tests — même convention que
 * les autres feuilles métier du projet (`geo/*`, `demandes-lifecycle.ts`,
 * `financial/fee-calculator.ts`).
 *
 * ── POURQUOI LA REFONTE (et pourquoi le #4A est supprimé) ─────────────
 *
 * Le programme #4A récompensait un NOMBRE DE MISSIONS (15 / 50 / 150 / 500).
 * Avec le barème de commission « 500 FCFA + 4 % » du chantier 4-FONDATIONS-A,
 * ce modèle est économiquement INSOUTENABLE : un client très actif-generait
 * autant de missions, donc autant de récompenses, sans que la valeur réellement
 * captée par Relio soit en rapport. Le coût du programme n'était pas borné.
 *
 * Le nouveau modèle se fonde sur la MARGE RÉELLE cumulée par le client — la
 * commission Relio prélevée sur chacune de ses missions confirmées. Le coût du
 * programme devient alors borné PAR CONSTRUCTION :
 *
 *     crédit = floor(marge / 10 000) × 500   soit  5 % de la marge à vie
 *
 * 5 % de la marge générée, quel que soit le nombre de missions, quel que soit
 * leur montant. Un palier atteint ne se reperd pas, la marge est cumulative à
 * vie (aucun reset annuel).
 *
 * ── RÈGLE FCFA ────────────────────────────────────────────────────────
 *
 * AUCUN montant n'est formaté dans ce fichier. `margeXAF` est un ENTIER ; c'est
 * `formatFCFA` côté frontend qui produit « 10 000 FCFA » À L'AFFICHAGE. Même
 * règle que `Notification.metadata` : un montant pré-formaté en base serait
 * figé pour tous les utilisateurs et impossible à re-localiser.
 *
 * `emoji` est la SEULE exception : c'est un glyphe, pas un montant.
 */

/* ------------------------------------------------------------------ */
/* Unités et barème                                                    */
/* ------------------------------------------------------------------ */

/**
 * Une tranche de marge vaut 10 000 XAF et rapporte 500 XAF de crédit.
 * Le ratio est donc de 5 % — c'est le plafond de coût du programme.
 */
export const CREDIT_TRANCHE_XAF = 10_000;
export const CREDIT_PER_TRANCHE_XAF = 500;

/** Fenêtre du signalement anti-fraude (inchangée depuis le #4A) :
 *  2 missions CONFIRMED consécutives du même client avec le même technicien,
 *  séparées de MOINS de 48 h. */
export const FRAUD_SAME_TECHNICIAN_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Motif littéral stocké dans `RewardFraudFlag.reason`. */
export const FRAUD_REASON_SAME_TECHNICIAN_48H = 'SAME_TECHNICIAN_48H';

/**
 * Montant minimal payé pour qu'une mission COMPTE (garde-fou conservé du
 * #4A) : sous ce seuil, la marge est symbolique et on ne fait pas progresser
 * la progression.
 */
export const MIN_MISSION_AMOUNT_XAF = 1_500;

/* ------------------------------------------------------------------ */
/* Paliers                                                             */
/* ------------------------------------------------------------------ */

/** Nom d'un palier badge. Miroir de l'enum Prisma `RewardTier`. */
export type RewardTierName = 'FIDELE' | 'OR' | 'PLATINE';

export const REWARD_TIER_NAMES: readonly RewardTierName[] = ['FIDELE', 'OR', 'PLATINE'];

/** Nom d'un palier nature. Miroir de l'enum Prisma `NatureRewardTier`. */
export type NatureTierName = 'ELECTROMENAGER_PETIT' | 'ELECTROMENAGER_MOYEN' | 'SMARTPHONE';

export const NATURE_TIER_NAMES: readonly NatureTierName[] = [
  'ELECTROMENAGER_PETIT',
  'ELECTROMENAGER_MOYEN',
  'SMARTPHONE',
];

/** Un palier badge : franchi sur la MARGE CUMULÉE. */
export interface RewardTierDefinition {
  readonly tier: RewardTierName;
  /** Marge cumulée requise, XAF ENTIER (jamais formatée). */
  readonly margeXAF: number;
  readonly label: string;
  readonly emoji: string;
}

/**
 * Les 3 paliers badge, dans l'ordre croissant des seuils. L'ordre du tableau
 * est significatif : `currentTier` et les notifications s'appuient dessus.
 */
export const TIER_THRESHOLDS: readonly RewardTierDefinition[] = [
  { tier: 'FIDELE', margeXAF: 10_000, label: 'Fidèle', emoji: '🥉' },
  { tier: 'OR', margeXAF: 50_000, label: 'Or', emoji: '🥇' },
  { tier: 'PLATINE', margeXAF: 100_000, label: 'Platine', emoji: '💎' },
] as const;

/** Un palier nature : récompensé enNature, sur la MÊME marge cumulée. */
export interface NatureTierDefinition {
  readonly tier: NatureTierName;
  readonly margeXAF: number;
  readonly label: string;
}

/**
 * Les 3 paliers nature, dans l'ordre croissant. CUMULABLES : un client peut
 * atteindre les trois, les réclamer un par un.
 */
export const NATURE_THRESHOLDS: readonly NatureTierDefinition[] = [
  { tier: 'ELECTROMENAGER_PETIT', margeXAF: 50_000, label: 'Petit électroménager' },
  { tier: 'ELECTROMENAGER_MOYEN', margeXAF: 100_000, label: 'Électroménager moyen' },
  { tier: 'SMARTPHONE', margeXAF: 250_000, label: 'Smartphone' },
] as const;

export const REWARD_TIER_BY_NAME: Readonly<Record<RewardTierName, RewardTierDefinition>> =
  TIER_THRESHOLDS.reduce(
    (acc, tier) => {
      acc[tier.tier] = tier;
      return acc;
    },
    {} as Record<RewardTierName, RewardTierDefinition>,
  );

export const NATURE_TIER_BY_NAME: Readonly<Record<NatureTierName, NatureTierDefinition>> =
  NATURE_THRESHOLDS.reduce(
    (acc, tier) => {
      acc[tier.tier] = tier;
      return acc;
    },
    {} as Record<NatureTierName, NatureTierDefinition>,
  );

/* ------------------------------------------------------------------ */
/* Fonctions pures                                                    */
/* ------------------------------------------------------------------ */

/** Le montant payé permet-il de faire progresser la progression ? */
export function isCountableAmount(finalAmountXAF: number | null | undefined): boolean {
  return (
    typeof finalAmountXAF === 'number' &&
    Number.isFinite(finalAmountXAF) &&
    finalAmountXAF >= MIN_MISSION_AMOUNT_XAF
  );
}

/** Deux confirmations sont-elles suspectes (même technicien, < 48 h) ? */
export function isSuspiciousSequence(
  technicianId: string | null,
  previousTechnicianId: string | null,
  elapsedMs: number,
): boolean {
  if (!technicianId || !previousTechnicianId) return false;
  if (technicianId !== previousTechnicianId) return false;
  return elapsedMs >= 0 && elapsedMs < FRAUD_SAME_TECHNICIAN_WINDOW_MS;
}

/**
 * Crédits cumulés pour une marge donnée : 500 XAF par tranche complète de
 * 10 000 XAF. C'est le plafond de 5 % — une marge de 9 999 ne rapporte rien,
 * une marge de 10 000 rapporte exactement 500.
 */
export function creditsEarnedForMargin(marginXAF: number): number {
  if (!Number.isFinite(marginXAF) || marginXAF <= 0) return 0;
  return Math.floor(marginXAF / CREDIT_TRANCHE_XAF) * CREDIT_PER_TRANCHE_XAF;
}

/** Crédits encore disponibles (jamais négatif). */
export function creditsAvailable(earnedXAF: number, claimedXAF: number): number {
  return Math.max(earnedXAF - claimedXAF, 0);
}

/**
 * Seuil de marge du prochain crédit, ou `null` si… jamais : il y a toujours
 * une tranche suivante, donc on renvoie toujours la borne supérieure.
 */
export function nextCreditTrancheAt(marginXAF: number): number {
  if (!Number.isFinite(marginXAF) || marginXAF < 0) return CREDIT_TRANCHE_XAF;
  return (Math.floor(marginXAF / CREDIT_TRANCHE_XAF) + 1) * CREDIT_TRANCHE_XAF;
}

/** Marge restant à générer avant le prochain crédit (jamais négatif). */
export function marginToNextCredit(marginXAF: number): number {
  return Math.max(nextCreditTrancheAt(marginXAF) - marginXAF, 0);
}

/** Le plus haut palier badge atteint à cette marge (`NONE` si aucun). */
export function tierForMargin(marginXAF: number): RewardTierName | 'NONE' {
  let best: RewardTierName | 'NONE' = 'NONE';
  for (const tier of TIER_THRESHOLDS) {
    if (marginXAF >= tier.margeXAF) best = tier.tier;
  }
  return best;
}

/**
 * Paliers badge nouvellement franchis par CETTE progression.
 *
 * Un client qui saute plusieurs paliers d'un coup les reçoit TOUS : chaque
 * palier franchi est une étape distincte, il doit les voir toutes.
 */
export function newlyReachedTiers(
  marginXAF: number,
  alreadyReached: readonly string[],
): RewardTierDefinition[] {
  const already = new Set(alreadyReached);
  return TIER_THRESHOLDS.filter((tier) => marginXAF >= tier.margeXAF && !already.has(tier.tier));
}

/** Seuil de marge du prochain palier badge, ou `null` si tous sont atteints. */
export function nextTierThreshold(marginXAF: number): number | null {
  const next = TIER_THRESHOLDS.find((tier) => marginXAF < tier.margeXAF);
  return next ? next.margeXAF : null;
}

/** Le plus haut palier nature atteint à cette marge (`NONE` si aucun). */
export function natureTierForMargin(marginXAF: number): NatureTierName | 'NONE' {
  let best: NatureTierName | 'NONE' = 'NONE';
  for (const tier of NATURE_THRESHOLDS) {
    if (marginXAF >= tier.margeXAF) best = tier.tier;
  }
  return best;
}

/** Paliers nature nouvellement atteints (cumulables). */
export function newlyReachedNature(
  marginXAF: number,
  alreadyReached: readonly string[],
): NatureTierDefinition[] {
  const already = new Set(alreadyReached);
  return NATURE_THRESHOLDS.filter(
    (tier) => marginXAF >= tier.margeXAF && !already.has(tier.tier),
  );
}

/** Seuil de marge du prochain palier nature, ou `null` si tous atteints. */
export function nextNatureThreshold(marginXAF: number): number | null {
  const next = NATURE_THRESHOLDS.find((tier) => marginXAF < tier.margeXAF);
  return next ? next.margeXAF : null;
}

/** Le nom de palier badge reçu en entrée d'endpoint est-il valide ? */
export function isRewardTierName(value: string): value is RewardTierName {
  return REWARD_TIER_NAMES.includes(value as RewardTierName);
}

/** Le nom de palier nature reçu en entrée d'endpoint est-il valide ? */
export function isNatureTierName(value: string): value is NatureTierName {
  return NATURE_TIER_NAMES.includes(value as NatureTierName);
}