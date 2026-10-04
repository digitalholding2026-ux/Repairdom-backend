#!/usr/bin/env node
/**
 * Migration recovery script for Railway deployment.
 * 
 * Handles the case where a migration is marked as FAILED in _prisma_migrations
 * but the DDL has already been applied (only the seed failed).
 * 
 * This script:
 * 1. Checks if migration 20261009010000_equipment_families is in FAILED state
 * 2. If so, runs the seed INSERT (idempotent with ON CONFLICT DO NOTHING)
 * 3. Marks the migration as applied via prisma migrate resolve --applied
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { execSync } from 'node:child_process';
import { PrismaClient } from '../dist/generated/prisma/client.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run the migration recovery script.');
}

const pool = new Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const TARGET_MIGRATION = '20261009010000_equipment_families';

async function main() {
  console.log('🔍 Checking migration status...');

  try {
    // Check if migration exists and is in failed state
    const migration = await prisma.$queryRaw`
      SELECT migration_name, finished_at, rolled_back_at, logs
      FROM "_prisma_migrations"
      WHERE migration_name = ${TARGET_MIGRATION}
    `;

    if (!migration || migration.length === 0) {
      console.log('ℹ️ Migration not found in _prisma_migrations. Nothing to recover.');
      return;
    }

    const mig = migration[0];
    console.log(`Found migration: ${mig.migration_name}`);
    console.log(`  finished_at: ${mig.finished_at}`);
    console.log(`  rolled_back_at: ${mig.rolled_back_at}`);
    console.log(`  logs: ${mig.logs}`);

    const isFailed = !mig.finished_at && !mig.rolled_back_at;
    
    if (!isFailed) {
      console.log('✅ Migration is not in failed state. No recovery needed.');
      return;
    }

    console.log('⚠️ Migration is in FAILED state. Attempting recovery...');

    // Step 1: Run the seed INSERT (idempotent with ON CONFLICT DO NOTHING)
    console.log('🌱 Running seed data insertion...');
    await prisma.$executeRawUnsafe(`
      INSERT INTO "EquipmentFamily" ("code", "label", "icon", "category", "sortOrder", "updatedAt") VALUES
        ('GAME_CONSOLE', 'Console / jeu vidéo', '🎮', 'electromenager', 10, CURRENT_TIMESTAMP),
        ('TV_ECRAN', 'Télévision / écran', '📺', 'electromenager', 20, CURRENT_TIMESTAMP),
        ('AUDIO_SON', 'Audio / sono', '🔊', 'electromenager', 30, CURRENT_TIMESTAMP),
        ('IMPRIMANTE', 'Imprimante / scanner', '🖨️', 'informatique', 40, CURRENT_TIMESTAMP),
        ('ENERGIE', 'Groupe électrogène / onduleur / solaire', '🔌', 'electricite', 50, CURRENT_TIMESTAMP),
        ('POMPE_EAU', 'Pompe à eau / forage', '💧', 'plomberie', 60, CURRENT_TIMESTAMP),
        ('VENTILATION', 'Ventilateur / brasseur d''air', '🌀', 'climatisation', 70, CURRENT_TIMESTAMP),
        ('COFFRE', 'Coffre-fort / serrure spéciale', '🔐', 'serrurerie', 80, CURRENT_TIMESTAMP),
        ('UNKNOWN', 'Je ne sais pas', '❓', 'autre', 100, CURRENT_TIMESTAMP)
      ON CONFLICT ("code") DO NOTHING;
    `);
    console.log('✅ Seed data inserted (or already present).');

    // Step 2: Mark migration as applied
    console.log('🔧 Marking migration as applied...');
    execSync(`npx prisma migrate resolve --applied 20261009010000_equipment_families`, {
      stdio: 'inherit',
      cwd: process.cwd()
    });
    console.log('✅ Migration marked as applied.');

    console.log('🎉 Recovery completed successfully!');

  } catch (error) {
    console.error('❌ Recovery failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();