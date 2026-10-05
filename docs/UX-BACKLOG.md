# Backlog UX — identifié lors du chantier #1

> Notes pour plus tard : aucun code associé, à traiter dans des chantiers dédiés.

- [ ] Page `/admin/connexion` dédiée (admin redirigé vers /client/connexion après reset)
- [ ] Renommer cookie `repairdom_token` → `relio_token` (dette technique)
- [ ] Vérifier `assertPasswordStrong` aussi appliquée sur /auth/register
- [ ] Supprimer routes temporaires /health/db et /health/migrations (post-diagnostic)
- [ ] Nettoyer test demande-multimedia.spec.ts "média seul → SUCCESS" : décrit un état devenu inatteignable via HTTP depuis la validation DTO
