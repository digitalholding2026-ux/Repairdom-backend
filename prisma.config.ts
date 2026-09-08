import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Fallback uniquement pour permettre `prisma generate` dès le build
    // sans base connectée. Le runtime, lui, exige une vraie DATABASE_URL
    // (validation stricte dans src/config/env.validation.ts).
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/repairdom',
  },
});