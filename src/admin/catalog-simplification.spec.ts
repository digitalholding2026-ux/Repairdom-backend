import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* Catalogue simplifié — garde-fous structurels (aucune base requise) :
 * la hiérarchie métier Catalogue → Spécification → Modèle → Catégorie →
 * Tarification repose sur les modèles existants (aucun renommage), les
 * ancres IA-5/IA-6 et l'historique restant intacts. */

const root = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(root, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
const service = readFileSync(join(root, 'catalog.service.ts'), 'utf8');

describe('catalogue simplifié — hiérarchie conservée', () => {
  it('modèles techniques inchangés (aucun renommage massif)', () => {
    for (const model of [
      'model ServiceDomain',
      'model DeviceBrand',
      'model DeviceModel',
      'model Problem',
      'model CatalogDiagnostic',
      'model CatalogIntervention',
      'model Pricing',
      'model PricingHistory',
      'model QuotePricingCheck',
      'model DiagnosticCatalogMatch',
    ]) {
      expect(schema).toContain(model);
    }
  });

  it('relations hiérarchiques intactes', () => {
    expect(schema).toMatch(/model DeviceBrand[\s\S]*?domain\s+ServiceDomain/);
    expect(schema).toMatch(/model DeviceModel[\s\S]*?brand\s+DeviceBrand/);
    expect(schema).toMatch(/model CatalogDiagnostic[\s\S]*?problem\s+Problem/);
    expect(schema).toMatch(/model CatalogIntervention[\s\S]*?diagnostic\s+CatalogDiagnostic/);
    expect(schema).toMatch(/model Pricing[\s\S]*?intervention\s+CatalogIntervention/);
    expect(schema).toMatch(/model PricingHistory[\s\S]*?pricing\s+Pricing/);
  });

  it('ancres IA-5 / IA-6 / historique intactes', () => {
    // IA-5 : correspondance analytique vers CatalogDiagnostic.
    expect(schema).toMatch(/model DiagnosticCatalogMatch[\s\S]*?catalogDiagnostic\s+CatalogDiagnostic/);
    // IA-6 : snapshot immuable par devis.
    expect(schema).toMatch(/model QuotePricingCheck[\s\S]*?minAtCheck/);
    expect(schema).toMatch(/model QuotePricingCheck[\s\S]*?maxAtCheck/);
    // Historique des prix conservé.
    expect(schema).toMatch(/model PricingHistory[\s\S]*?previousValues/);
    expect(schema).toMatch(/model PricingHistory[\s\S]*?newValues/);
  });

  it('CRUD + activation/désactivation exposés pour chaque niveau', () => {
    for (const method of [
      'createDomain',
      'updateDomain',
      'listBrands',
      'createBrand',
      'updateBrand',
      'listModels',
      'createModel',
      'updateModel',
      'createProblem',
      'updateProblem',
      'createDiagnostic',
      'updateDiagnostic',
      'createIntervention',
      'updateIntervention',
      'createPricing',
      'updatePricing',
      'deletePricing',
    ]) {
      expect(service).toContain(`async ${method}(`);
    }
  });

  it('validation des prix centralisée et réutilisée (jamais dupliquée)', () => {
    expect(service).toContain('assertPricingValid');
    // createPricing + updatePricing passent par la même autorité.
    const createUses = service.indexOf('async createPricing');
    const updateUses = service.indexOf('async updatePricing');
    expect(service.indexOf('this.assertPricingValid', createUses)).toBeGreaterThan(createUses);
    expect(service.indexOf('this.assertPricingValid', updateUses)).toBeGreaterThan(updateUses);
  });
});
