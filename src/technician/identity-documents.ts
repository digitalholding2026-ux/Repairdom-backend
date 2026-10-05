/**
 * Types de documents d'identité acceptés par Relio (parcours KYC technicien).
 *
 * UNE SEULE SOURCE côté backend : la « nature de la pièce » est un attribut
 * du PROFIL (`TechnicianProfile.kycIdentityDocType`), pas du fichier. Un
 * document = une ligne `KycDocument`, et la face est portée par
 * `KycDocument.side`.
 *
 * Volontairement minimal : pas de registre bureaucratique. La preuve
 * professionnelle est une capacité séparée et FACULTATIVE
 * (`KycDocumentType.PROFESSIONAL`), qui ne doit jamais bloquer un freelance.
 */

import type { KycDocumentSide } from '../generated/prisma/enums.js';

export const NATIONALITY_ALPHA2_LENGTH = 2;

export interface IdentityDocumentDefinition {
  /**
   * Faces EXIGÉES pour cette nature de pièce, telles qu'elles seront
   * enregistrées en base.
   *
   * Invariant : la liste décrit les côtés RÉELLEMENT stockés, pas les pages
   * physiques. Un passeport n'a pas de verso, et son unique page est donc
   * enregistrée `SINGLE` — pas `RECTO`. Décrire `requiresRecto: true` pour
   * un passeport rendrait la soumission impossible, puisque la face est
   * coercée en `SINGLE` au dépôt (cf. `normalizeKycDocumentSide`).
   *
   * Les trois portes — dépôt, normalisation, soumission — lisent cette MÊME
   * table : impossible qu'une exige une face que les autres ne produisent pas.
   */
  readonly requiredSides: readonly KycDocumentSide[];
}

export const IDENTITY_DOCUMENT_DEFINITIONS = {
  NATIONAL_ID_CARD: { requiredSides: ['RECTO', 'VERSO'] },
  PASSPORT: { requiredSides: ['SINGLE'] },
} as const satisfies Record<string, IdentityDocumentDefinition>;

export type IdentityDocumentType = keyof typeof IDENTITY_DOCUMENT_DEFINITIONS;

export const IDENTITY_DOCUMENT_TYPES = Object.keys(
  IDENTITY_DOCUMENT_DEFINITIONS,
) as IdentityDocumentType[];

export function isIdentityDocumentType(value: unknown): value is IdentityDocumentType {
  return typeof value === 'string' && value in IDENTITY_DOCUMENT_DEFINITIONS;
}

export function identityDocumentDefinition(
  value: IdentityDocumentType,
): IdentityDocumentDefinition {
  return IDENTITY_DOCUMENT_DEFINITIONS[value];
}

/** Libellé FR de la face manquante, par nature de pièce (messages d'erreur). */
const SIDE_LABEL: Record<KycDocumentSide, string> = {
  RECTO: 'le recto',
  VERSO: 'le verso',
  SINGLE: 'la page',
};

const SIDE_PHRASE: Record<IdentityDocumentType, string> = {
  NATIONAL_ID_CARD: 'de votre carte nationale',
  PASSPORT: 'de votre passeport',
};

/** « le recto de votre carte nationale » — utilisé par `submitKyc`. */
export function requiredSidePhrase(
  docType: IdentityDocumentType,
  side: KycDocumentSide,
): string {
  return `${SIDE_LABEL[side]} ${SIDE_PHRASE[docType]}`;
}