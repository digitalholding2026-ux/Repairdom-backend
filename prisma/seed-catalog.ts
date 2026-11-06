/**
 * M1 — point d'entrée CLI du seed du catalogue Relio v2.
 *
 * Exécution : `npm run db:seed:catalog` (Node 22 retire les types nativement).
 * La logique et les données vivent dans `seed-catalog-data.ts`, testées sans
 * base (RÈGLE 3). Ce fichier ne fait que brancher le client Prisma réel.
 *
 * Le client est chargé depuis `dist/`, pas depuis `src/generated/` : la
 * génération Prisma 7 produit des fichiers `.ts` dont les imports internes
 * s'écrivent en `.js`, spécificateurs que Node ne résout pas vers `.ts`. Il
 * faut donc que `npm run build` (prisma generate + nest build) ait tourné —
 * c'est le cas dans l'image Railway, où le build précède le pre-deploy.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { seedCatalogV2, type CatalogSeedClient } from './seed-catalog-data.ts';

const { PrismaClient } = await import('../dist/generated/prisma/client.js').catch(() => {
  throw new Error(
    'Client Prisma compilé introuvable : exécuter `npm run build` avant `npm run db:seed:catalog`.',
  );
});

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to seed the Relio v2 catalog.');
}

const pool = new Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

seedCatalogV2(prisma as unknown as CatalogSeedClient)
  .then(({ services, categories, items }) => {
    console.log(
      `Catalogue v2 seedé : ${services} services, ${categories} catégories, ${items} items.`,
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
