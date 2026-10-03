/* Formatage FCFA côté serveur (payloads push/narratifs uniquement — la
 * source reste l'entier XAF en base). `15 000 FCFA`, espace insécable,
 * sans décimales. */
export function formatFCFA(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const grouped = Math.round(amount)
    .toLocaleString('fr-FR')
    .replace(/\s/g, String.fromCharCode(160));
  return `${grouped} FCFA`;
}
