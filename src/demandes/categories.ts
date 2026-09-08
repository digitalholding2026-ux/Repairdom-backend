// Catégories partagées avec le frontend RepairDom (src/lib/data/request-categories.ts).
// Une catégorie ajoutée côté frontend doit être ajoutée ici pour être acceptée par l'API.
export const ALLOWED_CATEGORIES = [
  'electricite',
  'plomberie',
  'climatisation',
  'electromenager',
  'serrurerie',
  'informatique',
  'autre',
] as const;

export type DemandeCategory = (typeof ALLOWED_CATEGORIES)[number];