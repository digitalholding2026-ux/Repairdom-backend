/**
 * Chantier #4A — Programme de récompenses client : SEULE SOURCE DE VÉRITÉ
 * des paliers.
 *
 * Ce fichier ne contient QUE de la donnée et des règles pures : il est
 * volontairement sans dépendance Prisma, sans Nest, sans I/O. Il est donc
 * testable directement (vitest) et importable aussi bien par le service que
 * par les tests — même convention que les autres feuilles métier du projet
 * (`geo/*`, `demandes-lifecycle.ts`, `financial-fees.ts`).
 *
 * RÈGLE FCFA — à lire avant de modifier ce fichier :
 *   `reward` est un LABEL SANS MONTANT (« Réduction sur votre prochaine
 *   mission »), et `rewardValueXAF` est un ENTIER. Un montant pré-formaté
 *   dans un libellé serait figé pour tous les utilisateurs ; le formatage en
 *   FCFA est fait à l'affichage côté frontend par `formatFCFA`. Même règle que
 *   `Notification.metadata` (voir `notifications/notification-metadata.ts`).
 *
 * Règles de comptage (validées côté produit) :
 *   1. une mission compte si elle est CONFIRMED, payée `finalAmount >=
 *      MIN_MISSION_AMOUNT_XAF`, et sans signalement anti-fraude ouvert ;
 *   2. une seule récompense par palier (un palier atteint ne se rejoue pas) ;
 *   3. aucun reset annuel — les compteurs sont cumulatifs à vie.
 */

/** Palier de récompense. Miroir de l'enum Prisma `RewardTier`, sans
 *  `NONE` (qui est l'absence de palier, pas un palier). */
export type RewardTierName = 'BRONZE' | 'ARGENT' | 'OR' | 'PLATINE';

export const REWARD_TIER_NAMES: readonly RewardTierName[] = [
  'BRONZE',
  'ARGENT',
  'OR',
  'PLATINE',
];

/** Un palier, tel qu'envoyé au frontend. */
export interface RewardTierDefinition {
  readonly tier: RewardTierName;
  readonly label: string;
  /** Nombre de missions COMPTABILISÉES requis pour franchir le palier. */
  readonly missions: number;
  /** Libellé de la récompense, SANS montant (règle FCFA). */
  readonly reward: string;
  /** Valeur indicative de la récompense, XAF ENTIER (jamais formatée). */
  readonly rewardValueXAF: number;
}

/**
 * Les 4 paliers, dans l'ordre croissant des seuils. L'ordre du tableau est
 * significatif : `currentTier` et les notifications s'appuient dessus, donc
 * aucune réorganisation sans revalidation du service.
 */
export const REWARD_TIERS: readonly RewardTierDefinition[] = [
  {
    tier: 'BRONZE',
    missions: 15,
    label: 'Bronze',
    reward: 'Réduction sur votre prochaine mission',
    rewardValueXAF: 5_000,
  },
  {
    tier: 'ARGENT',
    missions: 50,
    label: 'Argent',
    reward: 'Main d’œuvre gratuite (plafond inclus)',
    rewardValueXAF: 15_000,
  },
  {
    tier: 'OR',
    missions: 150,
    label: 'Or',
    reward: 'Petit électroménager',
    rewardValueXAF: 25_000,
  },
  {
    tier: 'PLATINE',
    missions: 500,
    label: 'Platine',
    reward: 'Smartphone',
    rewardValueXAF: 200_000,
  },
] as const;

/** Palier par nom, pour les endpoints qui reçoivent un palier en paramètre. */
export const REWARD_TIER_BY_NAME: Readonly<Record<RewardTierName, RewardTierDefinition>> =
  REWARD_TIERS.reduce(
    (acc, tier) => {
      acc[tier.tier] = tier;
      return acc;
    },
    {} as Record<RewardTierName, RewardTierDefinition>,
  );

/* ------------------------------------------------------------------ */
/* Seuils et fenêtres                                                  */
/* ------------------------------------------------------------------ */

/** Montant minimal payé pour qu'une mission COMPTE.
 *  En dessous (mission Symbolic, frais de déplacement seuls, mission offerte),
 *  le compteur n'avance pas : le programme récompense des dépannages réels. */
export const MIN_MISSION_AMOUNT_XAF = 1_500;

/** Fenêtre du signalement anti-fraude : 2 missions CONFIRMED consécutives du
 *  même client avec le même technicien, séparées de MOINS de 48 h. */
export const FRAUD_SAME_TECHNICIAN_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Motif littéral stocké en `RewardFraudFlag.reason`. */
export const FRAUD_REASON_SAME_TECHNICIAN_48H = 'SAME_TECHNICIAN_48H';

/* ------------------------------------------------------------------ */
/* Fonctions pures                                                    */
/* ------------------------------------------------------------------ */

/** Le montant payé permet-il de compter la mission ? */
export function isCountableAmount(finalAmountXAF: number | null | undefined): boolean {
  return typeof finalAmountXAF === 'number' && Number.isFinite(finalAmountXAF) && finalAmountXAF >= MIN_MISSION_AMOUNT_XAF;
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
 * Paliers nouvellement franchis par un compteur donné.
 *
 * Point de vigilance : un client qui saute plusieurs paliers d'un coup (ex.
 * 49 missions puis la 50ᵉ franchit ARGENT d'un coup) les reçoit TOUS. Chaque
 * palier franchi est une récompense distincte et le client doit les voir
 * toutes : on ne garde donc pas « le plus haut ».
 *
 * @param missionCount compteur APRES incrément
 * @param reachedTiers paliers déjà franchis (jamais retirés)
 */
export function newlyReachedTiers(
  missionCount: number,
  reachedTiers: readonly string[],
): RewardTierDefinition[] {
  const already = new Set(reachedTiers);
  return REWARD_TIERS.filter((tier) => missionCount >= tier.missions && !already.has(tier.tier));
}

/** Palier le plus élevé parmi une liste (comparaison par seuil, pas par
 *  position dans le tableau : robuste à une réorganisation future). */
export function highestTier(tiers: readonly string[]): RewardTierName | 'NONE' {
  let best: RewardTierDefinition | null = null;
  for (const tier of REWARD_TIERS) {
    if (tiers.includes(tier.tier) && (!best || tier.missions > best.missions)) best = tier;
  }
  return best ? best.tier : 'NONE';
}

/** Progression vers le palier suivant, ou `null` si tous sont franchis. */
export function nextTierFor(
  missionCount: number,
): { tier: string; missions: number; remaining: number; label: string; reward: string; rewardValueXAF: number } | null {
  const next = REWARD_TIERS.find((tier) => missionCount < tier.missions);
  if (!next) return null;
  return {
    tier: next.tier,
    missions: next.missions,
    remaining: Math.max(next.missions - missionCount, 0),
    label: next.label,
    reward: next.reward,
    rewardValueXAF: next.rewardValueXAF,
  };
}

/** Le nom de palier reçu en entrée d'endpoint est-il valide ? */
export function isRewardTierName(value: string): value is RewardTierName {
  return REWARD_TIER_NAMES.includes(value as RewardTierName);
}
