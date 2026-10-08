/* RÈGLE FINANCIÈRE RELIO — barème de commission technicien
 * (chantier 4-FONDATIONS-A).
 *
 * RÈGLE MÉTIER VALIDÉE :
 *   - le technicien propose un montant X (le « devis ») ;
 *   - Relio ajoute 2 000 XAF de transport (pass-through : `STANDARD_TRANSPORT_FEE`) ;
 *   - le client paie X + 2 000 et ne paie AUCUNE commission Relio ;
 *   - le transport est intégralement reversé au technicien
 *     (écriture CREDIT distincte `TECHNICIAN_TRAVEL_REVENUE`) ;
 *   - la commission Relio est calculée sur X SEUL, JAMAIS sur X + 2 000.
 *
 *     commission = 500 + arrondi(4 % × X)
 *
 * Exemples canoniques :
 *
 *   Devis   Client paie   Commission   Technicien reçoit
 *   5 000      7 000          700           6 300
 *   10 000     12 000          900          11 100
 *   15 000     17 000        1 100          15 900
 *   25 000     27 000        1 500          25 500
 *   100 000   102 000        4 500          97 500
 *
 * Tous les montants sont des ENTIERS XAF. Le calcul est fait en arithmétique
 * entière (jamais de flottant) afin d'être déterministe d'une plateforme à
 * l'autre, comme le barème précédent.
 *
 * PORTÉE : ce module ne connaît QUE le montant du devis. Il ne dépend ni de
 * `STANDARD_TRANSPORT_FEE` ni du ledger : il est importable par la couche HTTP
 * (DTO), par le service de règlement et par les tests. `financial-fees.ts`
 * reste la source unique du TRANSPORT et des bornes de montants ; ce fichier
 * est la source unique du BARÈME DE COMMISSION.
 */

/** Part fixe de la commission, en XAF, prélevée sur chaque mission réglée. */
export const TECHNICIAN_FEE_FIXED_XAF = 500;

/** Part proportionnelle : 4 % du montant du devis. */
export const TECHNICIAN_FEE_RATE_NUMERATOR = 4;
export const TECHNICIAN_FEE_RATE_DENOMINATOR = 100;

/** Montant minimum d'une intervention (devis technicien), en XAF. */
export const MIN_QUOTE_AMOUNT_XAF = 5_000;

/* Message d'erreur appliqué à la création d'un devis sous le seuil.
 *
 * Le nombre est écrit en littéral : un test (`fee-calculator.spec.ts`) verrouille
 * la synchronisation entre ce message et `MIN_QUOTE_AMOUNT_XAF`, donc aucune
 * dérive silencieuse n'est possible si le seuil évolue.
 *
 * Espace ASCII (et non insécable) : ce texte part dans un corps de réponse JSON
 * consommé tel quel par le frontend, qui affiche « 5 000 FCFA » via
 * `formatFCFA` — pas de double normalisation. */
export const MIN_QUOTE_AMOUNT_ERROR_MESSAGE =
  "Le montant minimum d'une intervention est de 5 000 FCFA.";

/**
 * Commission Relio prélevée sur le montant du devis technicien.
 *
 * @param quoteAmountXAF montant du devis (réparation), entier XAF ≥ 0.
 * @returns commission en XAF, entier.
 * @throws si le montant n'est pas un entier XAF positif ou nul.
 */
export function calculateTechnicianFee(quoteAmountXAF: number): number {
  if (!Number.isInteger(quoteAmountXAF) || quoteAmountXAF < 0) {
    throw new Error('Le montant du devis doit être un entier XAF positif ou nul.');
  }
  /* Arrondi demi-supérieur, en entiers : (X × 4 + 50) ÷ 100. */
  const proportional = Math.floor(
    (quoteAmountXAF * TECHNICIAN_FEE_RATE_NUMERATOR + TECHNICIAN_FEE_RATE_DENOMINATOR / 2) /
      TECHNICIAN_FEE_RATE_DENOMINATOR,
  );
  return TECHNICIAN_FEE_FIXED_XAF + proportional;
}

/** Un devis peut-il être créé ? (montant entier, dans la borne basse). */
export function isQuoteAmountAllowed(quoteAmountXAF: number): boolean {
  return Number.isInteger(quoteAmountXAF) && quoteAmountXAF >= MIN_QUOTE_AMOUNT_XAF;
}