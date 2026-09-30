/* IA-9 — pagination et filtre période partagés des listes admin IA
 * (visualisation seule). `since` invalide → ignoré (jamais d'erreur). */

/** Page ≥ 1 (défaut 1). */
export function clampPage(page?: number): number {
  return Math.max(1, Math.floor(page ?? 1));
}

/** Limite 1..100 (défaut 20). */
export function clampLimit(limit?: number): number {
  return Math.min(Math.max(1, Math.floor(limit ?? 20)), 100);
}

/** Bornes ISO → Date valide, sinon null (filtre ignoré). */
export function parseSince(since?: string): Date | null {
  if (!since?.trim()) return null;
  const date = new Date(since.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Nombre de pages ≥ 1 pour un total donné. */
export function pageCount(total: number, limit: number): number {
  return Math.max(1, Math.ceil(total / limit));
}
