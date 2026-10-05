import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { TechnicianService } from './technician.service.js';

/* §14/§15 — nature de la pièce + faces (RECTO / VERSO / SINGLE).
 *
 * `normalizeKycDocumentSide` est une méthode privée : on l'atteint via
 * `as unknown as { ... }` plutôt que d'exposer une surface publique
 * supplémentaire. Le comportement testé est ici un contrat de l'API. */

type SideNormalizer = (
  type: string,
  side: string,
  declaredIdentityType: 'NATIONAL_ID_CARD' | 'PASSPORT' | null,
) => 'RECTO' | 'VERSO' | 'SINGLE';

function sideNormalizer(): SideNormalizer {
  // `normalizeKycDocumentSide` ne dépend d'aucun état injecté : un service
  // minimal suffit.
  const service = new TechnicianService({} as never, {} as never, {} as never);
  return (
    service as unknown as {
      normalizeKycDocumentSide: SideNormalizer;
    }
  ).normalizeKycDocumentSide.bind(service);
}

const normalize = sideNormalizer();

describe('normalizeKycDocumentSide — CNI (recto + verso)', () => {
  it('CNI : RECTO accepté', () => {
    expect(normalize('IDENTITY', 'RECTO', 'NATIONAL_ID_CARD')).toBe('RECTO');
  });

  it('CNI : VERSO accepté', () => {
    expect(normalize('IDENTITY', 'VERSO', 'NATIONAL_ID_CARD')).toBe('VERSO');
  });

  it('CNI : une face absente → SINGLE (dépôt dégradé, refus à la soumission)', () => {
    expect(normalize('IDENTITY', 'SINGLE', 'NATIONAL_ID_CARD')).toBe('SINGLE');
  });

  it('face vide → SINGLE', () => {
    expect(normalize('IDENTITY', '', 'NATIONAL_ID_CARD')).toBe('SINGLE');
  });

  it('face en minuscule / espaces → normalisée', () => {
    expect(normalize('IDENTITY', '  verso ', 'NATIONAL_ID_CARD')).toBe('VERSO');
  });
});

describe('normalizeKycDocumentSide — passeport (sans verso)', () => {
  it('passeport : RECTO → coerced en SINGLE (pas de verso demandé)', () => {
    expect(normalize('IDENTITY', 'RECTO', 'PASSPORT')).toBe('SINGLE');
  });

  it('passeport : SINGLE accepté', () => {
    expect(normalize('IDENTITY', 'SINGLE', 'PASSPORT')).toBe('SINGLE');
  });

  it('passeport : VERSO → refusé (le document n a pas de verso)', () => {
    expect(() => normalize('IDENTITY', 'VERSO', 'PASSPORT')).toThrow(BadRequestException);
  });

  it('passeport : RECTO et SINGLE convergent vers la MÊME ligne KycDocument', () => {
    // Condition de l'upsert `@@unique([technicianId, type, side])` : si les deux
    // ne convergeaient pas, un second dépôt créerait une doublon au lieu de
    // remplacer la pièce.
    expect(normalize('IDENTITY', 'RECTO', 'PASSPORT')).toBe(
      normalize('IDENTITY', 'SINGLE', 'PASSPORT'),
    );
  });
});

describe('normalizeKycDocumentSide — preuve professionnelle (facultative)', () => {
  it('toujours SINGLE, même si RECTO est demandé', () => {
    expect(normalize('PROFESSIONAL', 'RECTO', 'NATIONAL_ID_CARD')).toBe('SINGLE');
    expect(normalize('PROFESSIONAL', 'VERSO', null)).toBe('SINGLE');
    expect(normalize('PROFESSIONAL', 'SINGLE', null)).toBe('SINGLE');
  });

  it('une preuve pro n exige PAS de type de pièce déclaré', () => {
    expect(() => normalize('PROFESSIONAL', '', null)).not.toThrow();
  });
});

describe('normalizeKycDocumentSide — garde-fous', () => {
  it('face inconnue → 400', () => {
    expect(() => normalize('IDENTITY', 'ARRIERE', 'NATIONAL_ID_CARD')).toThrow(
      BadRequestException,
    );
  });

  it('RECTO/VERSO sans type de pièce déclaré → 400 (pas de dépôt « à l’aveugle »)', () => {
    expect(() => normalize('IDENTITY', 'RECTO', null)).toThrow(BadRequestException);
    expect(() => normalize('IDENTITY', 'VERSO', null)).toThrow(BadRequestException);
  });

  it('SINGLE sans type de pièce déclaré → toléré (dépôt libre, bloqué à la soumission)', () => {
    expect(normalize('IDENTITY', 'SINGLE', null)).toBe('SINGLE');
  });
});

describe('nationality — nomenclature fermée ISO 3166-1', () => {
  it('normalizeNationality normalise la casse et les espaces', async () => {
    const { normalizeNationality } = await import('./nationalities.js');
    expect(normalizeNationality(' cm ')).toBe('CM');
    expect(normalizeNationality('fr')).toBe('FR');
  });

  it('refuse une valeur non alpha-2', async () => {
    const { normalizeNationality } = await import('./nationalities.js');
    expect(normalizeNationality('C')).toBeNull();
    expect(normalizeNationality('CIV')).toBeNull();
    expect(normalizeNationality('12')).toBeNull();
    expect(normalizeNationality(null)).toBeNull();
  });

  it('la liste partagée couvre ISO 3166-1 alpha-2 sans doublon', async () => {
    const { NATIONALITIES, NATIONALITY_CODES } = await import('./nationalities.js');
    expect(NATIONALITY_CODES.size).toBe(NATIONALITIES.length);
    expect(isKnown('CM')).toBe(true);
    expect(isKnown('FR')).toBe(true);
    // Codes volontairement hors nomenclature (utilisés par les anciens salons).
    expect(isKnown('ZZ')).toBe(false);
    expect(isKnown('XX')).toBe(false);
    function isKnown(code: string) {
      return NATIONALITY_CODES.has(code);
    }
  });
});