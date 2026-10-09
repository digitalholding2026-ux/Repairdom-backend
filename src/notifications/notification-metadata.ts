/**
 * Contrat de `Notification.metadata` (chantier #2D — centre de notifications).
 *
 * RÈGLE FCFA, à lire avant toute écriture :
 *   - `title` et `message` restent des textes GÉNÉRIQUES, sans montant ;
 *   - tout montant est un ENTIER XAF dans `metadata` (jamais « 15 000 FCFA ») ;
 *   - le formatage FCFA est fait côté frontend par `formatFCFA`.
 *
 * Un montant pré-formaté en base serait figé pour tous les utilisateurs et
 * impossible à re-localiser. La base ne stocke que la valeur.
 *
 * Ce fichier est la SOURCE DE VÉRITÉ serveur du shape. Il n'est pas décoratif :
 * `buildNotificationMetadata` est appelé à chaque création de notification, ce
 * qui garantit qu'aucun `metadata` arbitraire ne se glisse en base.
 */

import { Prisma } from '../generated/prisma/client.js';

/** Montant en XAF entier (jamais formaté). */
export type NotificationAmountXAF = number;

/** Shape par type. Les clés sont OPTIONNELLES : tous les types partagent la
 *  même colonne JSON, la lecture doit donc tolérer un champ absent (notif
 *  créée avant le chantier, ou donnée non applicable).
 *
 *  La référence de mission N'EST PAS ici : elle est exposée par la
 *  sérialisation via la relation `demande.reference`. La dupliquer dans
 *  `metadata` créerait deux sources pour la même donnée, avec le risque qu'un
 *  endpoint affiche autre chose que l'autre. */
export interface NotificationMetadata {
  /** Devis concerné (QUOTE_*, NEGOTIATION_REQUESTED). */
  quoteId?: string;
  /** Montant du devis, XAF entier. */
  amountXAF?: NotificationAmountXAF;
  /** Barème maximal recommandé au moment du contrôle, XAF entier
   *  (PRICING_WARNING). */
  maxAmountXAF?: NotificationAmountXAF;
  /** Code devise du devis (`Quote.currency`, défaut `XAF`). */
  currency?: string;
  /** Prénom du technicien (QUOTE_CREATED côté client, TECHNICIAN_ACCEPTED). */
  technicianName?: string;
  /** Date de rendez-vous planifiée, ISO (SCHEDULED). */
  scheduledAt?: string;
  /** Montant final retenu sur la mission, XAF entier (CONFIRMED). */
  finalAmountXAF?: NotificationAmountXAF;
  /** Ville d'intervention (MISSION_AVAILABLE) : permet au technicien de
   *  savoir où se situe la mission sans l'ouvrir. */
  city?: string;
  /** Litige concerné (DISPUTE_*). */
  disputeId?: string;
  /** Catégorie de litige (DISPUTE_OPENED). */
  disputeCategory?: string;
  /** Statut du litige après décision (DISPUTE_RESOLVED). */
  disputeStatus?: string;
  /** Texte de la décision administrative (DISPUTE_RESOLVED). */
  resolution?: string;
  /** Statut KYC après décision administrative (KYC_VERIFIED / KYC_REJECTED).
   *  Valeurs : `VERIFIED` | `REJECTED`. */
  kycStatus?: string;
  /** Motif de rejet littéral saisi par l'admin (KYC_REJECTED). Affiché tel
   *  quel dans l'item de notification : c'est la seule information qui permet
   *  au technicien de corriger son dossier. */
  kycRejectionReason?: string;
  /** Action attendue côté technicien (KYC_VERIFIED / KYC_REJECTED) :
   *  `view_missions` (dossier validé) ou `fix_kyc` (dossier à corriger). */
  kycAction?: string;
  /** Palier de récompenses franchi, littéral (REWARD_TIER_REACHED) :
   *  `FIDELE` | `OR` | `PLATINE`. */
  rewardTier?: string;
  /** Libellé du palier (« Fidèle », « Platine »…). */
  rewardLabel?: string;
  /** Motif littéral du signalement anti-fraude (REWARD_MISSION_NOT_COUNTED) :
   *  `SAME_TECHNICIAN_48H`. Sert à l'app pour expliquer la décision ; le
   *  commentaire libre de l'admin n'est JAMAIS exposé au client. */
  rewardFraudReason?: string;
  /* ── Chantier 4-FONDATIONS-C : refonte LTV ───────────────────────────
   * Le #4A exposait `rewardMissions` (nombre de missions) et
   * `rewardValueXAF` (valeur du palier) : les deux sont SUPPRIMÉS, la
   * progression ne porte plus sur un nombre de missions. */

  /** Marge cumulée du client, XAF ENTIER (toutes notifications LTV). */
  rewardMarginXAF?: NotificationAmountXAF;
  /** Montant du CRÉDIT nouvellement acquis, XAF ENTIER
   *  (REWARD_CREDIT_EARNED). Jamais formaté ici : `formatFCFA` côté frontend. */
  rewardCreditXAF?: NotificationAmountXAF;
  /** Crédits encore disponibles après ce cumul
   *  (REWARD_CREDIT_EARNED). */
  rewardCreditAvailableXAF?: NotificationAmountXAF;
  /** Palier NATURE atteint, littéral : `ELECTROMENAGER_PETIT` |
   *  `ELECTROMENAGER_MOYEN` | `SMARTPHONE` (REWARD_NATURE_REACHED). */
  rewardNatureTier?: string;
  /** Libellé du palier nature (« Petit électroménager »…). */
  rewardNatureLabel?: string;
  /** Seuil de marge du palier nature, XAF ENTIER. */
  rewardNatureThresholdXAF?: NotificationAmountXAF;
  /** Seuil de marge du prochain badge, XAF ENTIER (`null` si tous atteints). */
  rewardNextTierXAF?: NotificationAmountXAF;
  /** Action attendue côté client. Valeurs :
   *  `view_rewards` (palier atteint, OUIVI) · `claim_credits`
   *  (REWARD_CREDIT_EARNED, ACTION : il doit cliquer) ·
   *  `claim_nature` (REWARD_NATURE_REACHED, ACTION : il doit réclamer) ·
   *  `contact_support` (REWARD_MISSION_NOT_COUNTED). */
  rewardAction?: string;
  /* ── Chantier 4B — parrainage ─────────────────────────────────────────
   * Les montants du parrainage sont des ENTIERS XAF, jamais formatés : même
   * règle que le reste du ledger.
   */

  /** Montant crédité au PARRAIN, XAF ENTIER (REFERRAL_REWARDED). */
  referralRewardXAF?: NotificationAmountXAF;
  /** Montant crédité au FILLEUL (bonus de bienvenue), XAF ENTIER
   *  (REFERRAL_WELCOME). */
  referralWelcomeXAF?: NotificationAmountXAF;
  /** Prénom du filleul récompensé (REFERRAL_REWARDED) — permet au parrain de
   *  reconnaître qui a déclenché la récompense. */
  referralReferredName?: string;
  /** Action attendue côté client (REFERRAL_REWARDED) : `view_referrals`
   *  (consulter / partager davantage) · `view_balance` (REFERRAL_WELCOME,
   *  simple information). */
  referralAction?: string;
}

/**
 * Entrée du constructeur : chaque clé accepte explicitement `null`, qui
 * signifie « non applicable pour ce type ». C'est le cas le plus fréquent au
 * câblage (`finalAmountXAF: current.finalAmount ?? null` quand la mission n'a
 * pas de devis accepté).
 */
export type NotificationMetadataInput = {
  [K in keyof NotificationMetadata]?: NotificationMetadata[K] | null;
};

/**
 * Construit un `metadata` valide en ne gardant QUE les clés définies et en
 * écartant les valeurs `undefined` (quiBecomment `null` en JSON et pollueraient
 * la lecture frontend).
 *
 * Le typage seul ne suffit pas : `metadata` est un JSON libre, et un appelant
 * peut passer un objet typé `Record<string, unknown>`. Cette fonction est le
 * filtre réel.
 */
/** Liste des clés autorisées : une colonne JSON libre accepterait n'importe
 *  quoi, ce `buildNotificationMetadata` est le FILTRE RÉEL. */
const METADATA_KEYS: Array<keyof NotificationMetadata> = [
  'quoteId',
  'amountXAF',
  'maxAmountXAF',
  'currency',
  'technicianName',
  'scheduledAt',
  'finalAmountXAF',
  'city',
  'disputeId',
  'disputeCategory',
  'disputeStatus',
  'resolution',
  'kycStatus',
  'kycRejectionReason',
  'kycAction',
  'rewardTier',
  'rewardLabel',
  'rewardAction',
  'rewardFraudReason',
  /* Chantier 4-FONDATIONS-C — refonte LTV. */
  'rewardMarginXAF',
  'rewardCreditXAF',
  'rewardCreditAvailableXAF',
  'rewardNatureTier',
  'rewardNatureLabel',
  'rewardNatureThresholdXAF',
  'rewardNextTierXAF',
  /* Chantier 4B — parrainage. */
  'referralRewardXAF',
  'referralWelcomeXAF',
  'referralReferredName',
  'referralAction',
];

/**
 * Construit un `metadata` conforme, prêt pour Prisma.
 *
 * Renvoie un objet `InputJsonObject` (index signature) : Prisma exige ce
 * type pour un champ `Json`, une interface sans index signature n'est pas
 * assignable.
 */
export function buildNotificationMetadata(
  input: NotificationMetadataInput | null | undefined,
): Prisma.InputJsonObject | undefined {
  if (!input) return undefined;
  /* `InputJsonObject` n'autorise que la LECTURE par index signature : on
   * construit donc un objet mutable, puis on le fige au type attendu. */
  const out: Record<string, Prisma.InputJsonValue> = {};
  for (const key of METADATA_KEYS) {
    const value = input[key];
    /* `undefined` : non fourni. `null` : non applicable pour ce type (on
     * l'écarte aussi, sinon le frontend afficherait « null »). */
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? (out as Prisma.InputJsonObject) : undefined;
}