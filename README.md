# RepairDom — Backend

API REST du SaaS RepairDom, construite avec **Node.js**, **NestJS**, **TypeScript**,
**Prisma** et **PostgreSQL**. Interaction mobile-first pour la mise en relation entre
clients et techniciens locaux.

> Ce dépôt correspond uniquement au backend. Le frontend (Next.js) vit dans le dépôt
> `Repairdom-frontend` (dossier `frontend/`).

## Prérequis

- Node.js >= 22
- PostgreSQL local (ou une base distante comme Railway)
- npm ou pnpm

## Installation

```bash
npm install        # ou : pnpm install
cp .env.example .env   # puis renseigner DATABASE_URL
```

## Configuration

Les variables d'environnement sont décrites dans `.env.example` :

| Variable          | Description                                                        |
|-------------------|--------------------------------------------------------------------|
| `NODE_ENV`        | `development` \| `production` \| `test`                            |
| `PORT`            | Port HTTP de l'API (défaut : `3000`)                               |
| `DATABASE_URL`    | URL de connexion PostgreSQL (Prisma)                                |
| `CORS_ORIGINS`    | Origines autorisées, séparées par des virgules (vide = toutes)     |

Les variables sont validées au démarrage (via `src/config/env.validation.ts`).

## Générer le client Prisma

```bash
npm run db:generate    # prisma generate
```

## Lancer le backend

```bash
npm run start:dev      # mode développement (watch)
npm run start:prod     # mode production (après build)
```

Le serveur écoute sur `http://localhost:3000`.

## Health check

```bash
curl http://localhost:3000/api/health
```

Réponse : `{ "status": "ok", "database": "up", "uptime": ..., "timestamp": ... }`.

## Scripts

| Commande                 | Description                                     |
|--------------------------|-------------------------------------------------|
| `npm run build`          | `prisma generate` + `nest build`                |
| `npm run start:dev`      | Démarrage en développement (watch)              |
| `npm run start:prod`     | Démarrage du build de production                |
| `npm run lint`           | Analyse de code (oxlint)                        |
| `npm run test`           | Tests unitaires (vitest)                        |
| `npm run test:e2e`       | Tests e2e (vitest)                              |
| `npm run db:migrate`     | Créer/appliquer une migration Prisma            |
| `npm run db:migrate:deploy` | Appliquer les migrations (production)       |
| `npm run db:studio`      | Ouvrir Prisma Studio                            |

## Déploiement (Railway)

1. Connecter le dépôt à Railway ; Railway injecte automatiquement `DATABASE_URL`
   via le provider PostgreSQL.
2. Définir `PORT` (Railway fournit `PORT` automatiquement) et `CORS_ORIGINS`
   (l'URL du frontend déployé).
3. Script de démarrage : `npm run start:prod` (ou `node dist/main`).
4. Après chaque déploiement, appliquer les migrations :
   `npm run db:migrate:deploy`.