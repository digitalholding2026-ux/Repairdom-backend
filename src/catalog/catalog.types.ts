/**
 * M1 — contrats de sortie du catalogue v2. Le montant reste un entier XAF :
 * le formatage « FCFA » n'existe qu'à l'affichage, côté frontend.
 */

/** `price` null = prestation sans tarif annoncé, chiffrée après contact. */
export interface CatalogPriceView {
  price: number | null;
  surDevis: boolean;
}

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

export interface CatalogItemView {
  id: string;
  categoryId: string;
  code: string;
  label: string;
  description: string | null;
  androidVersion: string | null;
  order: number;
  price: number | null;
  surDevis: boolean;
}
