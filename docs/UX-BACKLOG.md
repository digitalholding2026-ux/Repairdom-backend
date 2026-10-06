# Backlog UX — identifié lors du chantier #1

> Notes pour plus tard : aucun code associé, à traiter dans des chantiers dédiés.

- [ ] Page `/admin/connexion` dédiée (admin redirigé vers /client/connexion après reset)
- [ ] Renommer cookie `repairdom_token` → `relio_token` (dette technique)
- [ ] Vérifier `assertPasswordStrong` aussi appliquée sur /auth/register
- [ ] Supprimer routes temporaires /health/db et /health/migrations (post-diagnostic)
- [ ] Nettoyer test demande-multimedia.spec.ts "média seul → SUCCESS" : décrit un état devenu inatteignable via HTTP depuis la validation DTO
- [ ] Nettoyer toute référence à `api.relioo.space` (n'existe pas).
      Chercher dans `.env.example`, README, commentaires.
      Emplacements connus : `backend/.env.example`, `backend/src/saspay/saspay.config.ts`,
      `backend/src/saspay/saspay-api.client.spec.ts`,
      `frontend/src/lib/no-middleware.test.ts` (message d'un test).
      → À traiter dans un chantier SasPay DÉDIÉ, avec le WIP SasPay/MSISDN déjà
      en attente (extraction du normaliseur MSISDN dans `src/common/msisdn.ts`,
      encore non commité). Volontairement hors #5A : le relay payout est un
      composant séparé, sans rapport avec les notifications KYC.
- [ ] Clarifier dans les docs que le backend Relio tourne sur Railway, pas sur le VPS (le VPS est un autre service).
- [ ] Commit séparé pour saspay-networks.ts + msisdn.ts (WIP hors #5B).
      `src/saspay/saspay-networks.ts` (ré-export du normaliseur) et
      `src/common/msisdn.ts` (nouveau module) sont en attente sur l'arbre de
      travail depuis #5A/#5B, volontairement exclus des commits de ces
      chantiers. Chantier SasPay à ouvrir séparément.
- [ ] `package-lock.json` désynchronisé de `package.json`.
      `npm ci` échoue en `EUSAGE` (`Missing: typescript@5.9.3 from lock file`) :
      `package.json` demande `typescript@^6.0.2`, le lock résout `6.0.3`, et
      `@nestjs/cli` réclame `~6.0.2` en dépendance dure sans entrée correspondante.
      → Vérifier si le builder Nixpacks de Railway exécute réellement `npm ci`.
      Les déploiements #5A et #5B sont passés, donc le build n'est pas cassé en
      pratique, mais le lock reste inutilisable en local et le serait en CI.
      Traiter dans un commit dédié (`npm install` pour régénérer le lock), sans
      le mélanger à un chantier fonctionnel.
- [ ] Échec de test pré-existant FRONTEND : `design-system.test.ts`
      (« logo : le pin est posé sur la ligne de base du texte »).
      Vérifié en échec sur `main` sans modification locale (au moment du commit
      `21ee3c7`). Sans rapport avec l'inscription technicien.
- [ ] Échecs de tests pré-existants BACKEND : `demande-multimedia.spec.ts`
      (3 tests sur `description` / médias).
      Idem vérifiés en échec sur `main` au commit `b907455`. Le même fichier est
      déjà listé plus haut pour un état devenu inatteignable via HTTP : à traiter
      dans la même passe.

Note sur la couverture des tests d'inscription technicien (`21ee3c7`) :
les tests frontend du chantier #5B sont des CONTRATS par lecture statique des
sources (convention du dépôt, cf. `no-middleware.test.ts`), pas du rendu React :
l'alias `@/` interdit d'importer le composant dans `node --test`. Limitation
acceptée — ces tests verrouillent la chaîne formulaire → service → payload
(`signUp` relaie bien `cityId` dans le corps HTTP, bug à l'origine du 400), ce
qui est le niveau de garantie suffisant ici. Pas de bibliothèque de rendu React
à introduire pour ce chantier.

## Chantier D1 — brouillon de demande (suivis)

- [ ] **Cleanup des `DemandeDraft` orphelins (7 j+)** : la purge est
      **paresseuse** (`deleteMany` déclenché à la création d'un nouveau
      brouillon, `DemandeDraftService.create`), sans cron — le dépôt n'a pas de
      `@nestjs/schedule`. Une table qui ne reçoit plus de créations ne se purge
      donc plus. Surveiller `SELECT count(*) FROM "DemandeDraft"` en prod après
      3 mois ; si la table grossit sans que la purge suive (faible trafic sur
      `/demandes/drafts`), basculer sur un job planifié.
      Rappel : seuls les brouillons **non convertis** sont purgés — un brouillon
      converti est conservé au-delà de l'expiration (trace du rattachement et
      preuve anti-rejeu du `token`).
- [ ] `deleteMany` de purge n'est pas borné (`deleteMany` ne supporte pas
      `take`). Le filtre s'appuie sur `@@index([expiresAt])`. À surveiller en
      même temps que le point ci-dessus.
- [ ] `DemandeDraftService.conversions` (sérialisation in-process des
      conversions concurrentes d'un même `token`) n'est valable que sur une
      instance unique. En cas de passage multi-instance Railway, remplacer par
      une colonne d'état en base (`convertingAt`) — l'index unique sur
      `convertedToDemandeId` reste, lui, la vraie barrière.
