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
