/**
 * M1 — contrats de sortie du catalogue v2. Le montant reste un entier XAF :
 * le formatage « FCFA » n'existe qu'à l'affichage, côté frontend.
 */

export interface CatalogServiceView {
  id: string;
  code: string;
  label: string;
  description: string | null;
}

export interface CatalogCategoryView {
  id: string;
  serviceId: string;
  code: string;
  label: string;
  order: number;
}

/**
 * Un item servi a toujours un montant : la lecture filtre les items dont le
 * tarif du visiteur est absent. `price` reste `number | null` parce que
 * l'administration, elle, liste aussi les items non tarifés.
 */
export interface CatalogItemView {
  id: string;
  categoryId: string;
  code: string;
  label: string;
  description: string | null;
  androidVersion: string | null;
  order: number;
  price: number | null;
  paymentType: string;
}
