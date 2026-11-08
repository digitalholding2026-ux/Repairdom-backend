/**
 * M1 — données et logique du seed du catalogue Relio v2.
 *
 * Séparé de `seed-catalog.ts` (l'exécutable) pour que la logique d'upsert
 * soit testable en mémoire, sans base joignable (RÈGLE 3).
 *
 * Idempotent : chaque écriture est un `upsert` adressé par la contrainte unique
 * naturelle du document (`Service.code`, `CatalogCategory(serviceId, code)`,
 * `CatalogItem(categoryId, code)`). Rejouer le seed met à jour les libellés,
 * les prix et les drapeaux d'activité, ne crée jamais de doublon.
 *
 * Le seed est VOLONTAIREMENT AUTORITAIRE pour les items qu'il déclare : un
 * libellé, un tarif ou une activité changés à la main par l'administration est
 * réaligné au déploiement suivant. Les tarifs null et `active: false` sont une
 * donnée de configuration, pas un accident : un item sans prix n'est servi à
 * personne, il attend sa tarification.
 */

/** Prix public / professionnel à null = aucun montant annoncé. */
export type SeedItem = {
  code: string;
  label: string;
  description?: string | null;
  androidVersion?: string | null;
  pricePublic: number | null;
  pricePro: number | null;
  active: boolean;
};

export type SeedCategory = {
  code: string;
  label: string;
  items: SeedItem[];
};

export type SeedService = {
  code: string;
  label: string;
  proAvailable: boolean;
  categories: SeedCategory[];
};

/** Modèles Tecno débloquables, groupés par version d'Android embarquée. */
export const TECNO_FRp_ITEMS: SeedItem[] = Object.entries(TECNO_BY_ANDROID).flatMap(
  ([androidVersion, models]) =>
    models.map((modelName) => ({
      code: itemCode(modelName),
      label: modelName,
      description: null,
      androidVersion,
      pricePublic: 3000,
      pricePro: 1500,
      active: true,
    })),
);

/** Quelques modèles Infinix débloquables (parcours grand public, à compléter). */
export const INFINIX_ITEMS: SeedItem[] = [
  {
    code: 'INFINIX_NOTE_30',
    label: 'Infinix Note 30',
    description: null,
    androidVersion: '13',
    pricePublic: 3000,
    pricePro: 1500,
    active: true,
  },
  {
    code: 'INFINIX_HOT_30',
    label: 'Infinix Hot 30',
    description: null,
    androidVersion: '13',
    pricePublic: 3000,
    pricePro: 1500,
    active: true,
  },
];

/** Quelques modèles Itel débloquables (parcours grand public, à compléter). */
export const ITEL_ITEMS: SeedItem[] = [
  {
    code: 'ITEL_A70',
    label: 'Itel A70',
    description: null,
    androidVersion: '13',
    pricePublic: 3000,
    pricePro: 1500,
    active: true,
  },
  {
    code: 'ITEL_S23',
    label: 'Itel S23',
    description: null,
    androidVersion: '12',
    pricePublic: 3000,
    pricePro: 1500,
    active: true,
  },
];

export const SERVICES: SeedService[] = [
  {
    code: 'SYSTEME',
    label: 'Réparation système',
    proAvailable: true,
    categories: [
      {
        code: 'REINSTALL_OS',
        label: 'Réinstallation OS + drivers',
        items: [
          {
            code: 'REINSTALL_OS',
            label: 'Réinstallation OS + drivers',
            pricePublic: 5000,
            pricePro: 2500,
            active: true,
          },
        ],
      },
      {
        code: 'DRIVERS',
        label: 'Installation pilotes',
        items: [
          {
            code: 'DRIVERS',
            label: 'Installation pilotes',
            pricePublic: 2500,
            pricePro: 1250,
            active: true,
          },
        ],
      },
      {
        code: 'SOFTWARE',
        label: 'Installation logiciel',
        // Non tarifié : hors parcours tant que le barème n'existe pas.
        items: [
          {
            code: 'SOFTWARE',
            label: 'Installation logiciel',
            pricePublic: null,
            pricePro: null,
            active: false,
          },
        ],
      },
      {
        code: 'DEBRIDAGE',
        label: 'Débridage / nettoyage',
        items: [
          {
            code: 'DEBRIDAGE',
            label: 'Débridage / nettoyage',
            pricePublic: null,
            pricePro: null,
            active: false,
          },
        ],
      },
    ],
  },
  {
    code: 'SMARTPHONE',
    label: 'Réparation smartphone',
    proAvailable: false,
    // Barème public uniquement : la prestation est réservée aux particuliers,
    // aucun tarif professionnel n'est annoncé. « Autre » reste hors parcours
    // tant que son barème n'existe pas.
    categories: [
      {
        code: 'SCREEN',
        label: 'Écran',
        items: [
          {
            code: 'SCREEN',
            label: 'Écran (Tecno / Infinix / itel)',
            pricePublic: 9000,
            pricePro: null,
            active: true,
          },
        ],
      },
      {
        code: 'BATTERY',
        label: 'Batterie',
        items: [
          {
            code: 'BATTERY',
            label: 'Batterie (Tecno / Infinix / itel)',
            pricePublic: 5000,
            pricePro: null,
            active: true,
          },
        ],
      },
      {
        code: 'CONNECTOR',
        label: 'Connecteur de charge',
        items: [
          {
            code: 'CONNECTOR',
            label: 'Module de charge (Tecno / Infinix / itel)',
            pricePublic: 2000,
            pricePro: null,
            active: true,
          },
        ],
      },
      {
        code: 'OTHER',
        label: 'Autre',
        items: [{ code: 'OTHER', label: 'Autre', pricePublic: null, pricePro: null, active: false }],
      },
    ],
  },
  {
    code: 'FRP',
    label: 'Déblocage',
    proAvailable: true,
    categories: [
      { code: 'TECNO', label: 'Tecno', items: TECNO_FRp_ITEMS },
      { code: 'INFINIX', label: 'Infinix', items: INFINIX_ITEMS },
      { code: 'ITEL', label: 'Itel', items: ITEL_ITEMS },
    ],
  },
];

/** Nombre d'objets que le seed doit produire (contrôle d'idempotence). */
export const SEED_TOTALS = {
  services: SERVICES.length,
  categories: SERVICES.reduce((sum, service) => sum + service.categories.length, 0),
  items: SERVICES.reduce(
    (sum, service) => sum + service.categories.reduce((s, c) => s + c.items.length, 0),
    0,
  ),
};

/** Client minimal requis par le seed (PrismaClient, ou double de test). */
export interface CatalogSeedClient {
  service: {
    upsert(args: {
      where: { code: string };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<{ id: string }>;
  };
  catalogCategory: {
    upsert(args: {
      where: { serviceId_code: { serviceId: string; code: string } };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<{ id: string }>;
  };
  catalogItem: {
    upsert(args: {
      where: { categoryId_code: { categoryId: string; code: string } };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/** Applique le seed sur un client donné. Retourne les volumes écrits. */
export async function seedCatalogV2(
  prisma: CatalogSeedClient,
): Promise<{ services: number; categories: number; items: number }> {
  let services = 0;
  let categories = 0;
  let items = 0;

  for (const service of SERVICES) {
    const serviceRow = await prisma.service.upsert({
      where: { code: service.code },
      update: { label: service.label, proAvailable: service.proAvailable },
      create: { code: service.code, label: service.label, proAvailable: service.proAvailable },
    });
    services += 1;

    for (const [categoryIndex, category] of service.categories.entries()) {
      const categoryRow = await prisma.catalogCategory.upsert({
        where: { serviceId_code: { serviceId: serviceRow.id, code: category.code } },
        update: { label: category.label, order: (categoryIndex + 1) * 10 },
        create: {
          serviceId: serviceRow.id,
          code: category.code,
          label: category.label,
          order: (categoryIndex + 1) * 10,
        },
      });
      categories += 1;

      for (const [itemIndex, item] of category.items.entries()) {
        await prisma.catalogItem.upsert({
          where: { categoryId_code: { categoryId: categoryRow.id, code: item.code } },
          update: {
            label: item.label,
            description: item.description ?? null,
            androidVersion: item.androidVersion ?? null,
            pricePublic: item.pricePublic,
            pricePro: item.pricePro,
            order: (itemIndex + 1) * 10,
            active: item.active,
          },
          create: {
            categoryId: categoryRow.id,
            code: item.code,
            label: item.label,
            description: item.description ?? null,
            androidVersion: item.androidVersion ?? null,
            pricePublic: item.pricePublic,
            pricePro: item.pricePro,
            order: (itemIndex + 1) * 10,
            active: item.active,
          },
        });
        items += 1;
      }
    }
  }

  return { services, categories, items };
}
