import { BaseDemandeDto } from './base-demande.dto.js';

/* Chantier D1 — création d'un brouillon par un visiteur NON authentifié.
 *
 * Mêmes champs et mêmes validateurs que `CreateDemandeDto` (hérités de
 * `BaseDemandeDto`), SAUF `medias` : décision D1-2, les médias sont reportés
 * après inscription. Le corps ne peut donc pas contenir de champ `medias` :
 * la ValidationPipe globale tourne en `whitelist: true` +
 * `forbidNonWhitelisted: true`, il serait rejeté en 400 — c'est le
 * comportement voulu, un brouillon n'a pas à porter d'octets.
 */
export class CreateDemandeDraftDto extends BaseDemandeDto {}