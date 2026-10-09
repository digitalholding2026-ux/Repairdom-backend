/* TRANSPARENCE SASPAY — barème des frais du prestataire de paiement.
 *
 * Taux mesurés sur transactions réelles en production (chantier
 * TRANSPARENCE-SASPAY) :
 *
 *   - Encaissement (recharge client) : 4,5 % AJOUTÉS au client.
 *     Mesuré : le client saisit 2 000, SasPay débite 2 090, Relio crédite
 *     2 000. Les 90 sont donc supportés par le client — et doivent être
 *     affichés AVANT qu'il valide.
 *
 *   - Décaissement (payout technicien) : 3,5 % DÉDUITS du montant envoyé.
 *     Taux PUR, confirmé sur deux mesures : 2 000 envoyés → 1 930 reçus ;
 *     500 envoyés → 482,50 reçus. Donc PAS de minimum de frais : la
 *     majoration `net / (1 − r)` est valable jusqu'aux petits montants.
 *
 * PORTÉE ET SÉPARATION DES RESPONSABILITÉS
 * Ce module ne connaît QUE des montants. Il ne dépend ni du ledger, ni de
 * SasPay, ni de la configuration réseau : il est importable par la couche
 * HTTP, par le service de payout et par les tests.
 *
 * `financial-fees.ts` reste la source unique des BORNES de montants et du
 * transport ; `fee-calculator.ts` celle du barème de commission Relio. Aucun
 * taux SasPay ne doit être redéfini ailleurs.
 *
 * Les frais constatés côté prestataire (`fee`, `chargedAmount`, `netAmount`
 * renvoyés par l'API) restent la seule vérité comptable : ces fonctions ne
 * servent qu'à ANTICIPER un montant, jamais à recalculer un règlement.
 * L'encaissement côté client n'est PAS calculé ici côté backend : le montant
 * débité par SasPay est celui qu'il renvoie (voir
 * `financial.service.ts` → `confirmTopupFromSasPay`, qui crédite le
 * `netAmountMinor` constaté).
 */

/** Encaissement : frais ajoutés au client sur une recharge (4,5 %). */
export const SASPAY_COLLECT_RATE = 0.045;

/** Décaissement : frais déduits du montant envoyé au technicien (3,5 %). */
export const SASPAY_PAYOUT_RATE = 0.035;

/**
 * Montant brut à envoyer à SasPay pour que le bénéficiaire reçoive
 * EXACTEMENT `netXAF` (Option A : Relio absorbe les frais).
 *
 * Le taux de 3,5 % est PUR (vérifié sur 500 et sur 2 000), donc aucune
 * borne plancher n'est appliquée : `ceil` garantit seulement que l'arrondi
 * ne fait jamais perdre un XAF au technicien. Le frais supporté par Relio
 * est la différence entre le brut et le net — il n'est JAMAIS exposé au
 * technicien (cf. `saspay-relio-absorbs-fees.ts` côté frontend).
 *
 * @param netXAF montant net demandé par le bénéficiaire, entier XAF > 0.
 * @returns montant brut à envoyer à SasPay, entier XAF.
 */
export function computeSaspayPayoutCharged(netXAF: number): number {
  if (!Number.isFinite(netXAF) || netXAF <= 0) return 0;
  return Math.ceil(netXAF / (1 - SASPAY_PAYOUT_RATE));
}

/**
 * Frais de payout SasPay supportés par RELIO (Option A).
 * C'est le coût réel de la promesse « le technicien reçoit le net affiché » :
 * il est calculé côté serveur pour la comptabilité, jamais affiché au
 * technicien.
 */
export function computeSaspayPayoutFee(netXAF: number): number {
  return computeSaspayPayoutCharged(netXAF) - netXAF;
}

/**
 * Frais d'encaissement SasPay que le client paie sur une recharge.
 * Arrondi au XAF supérieur : le total débité ne doit jamais être inférieur à
 * ce que l'UI a annoncé.
 */
export function computeSaspayCollectFee(amountXAF: number): number {
  if (!Number.isFinite(amountXAF) || amountXAF <= 0) return 0;
  return Math.ceil(amountXAF * SASPAY_COLLECT_RATE);
}

/**
 * Total réellement débité au client pour un solde crédité de `amountXAF`.
 * La recharge est un `ADD_ON` : le client paie son solde + les frais.
 */
export function computeSaspayCollectTotal(amountXAF: number): number {
  return amountXAF + computeSaspayCollectFee(amountXAF);
}