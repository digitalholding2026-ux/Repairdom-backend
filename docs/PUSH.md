# Push web VAPID (chantier #2B, complément du SSE pour app fermée)

> Le push est un COMPLÉMENT du SSE, jamais un remplacement : si une connexion
> SSE est active pour l'utilisateur, aucun push n'est envoyé (sauf `force`).

## Clés VAPID

Générer (machine de confiance, jamais commité) :

```bash
npx web-push generate-vapid-keys
```

Stocker :
- Railway → Variables : `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT=mailto:contact@relioo.space`.
- Vercel → `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (même valeur que la publique).

Sans clés : l'envoi est désactivé proprement (log + skip, aucun crash) et
`GET /push/vapid-public-key` retourne `{ publicKey: null }`.

## Endpoints (`/api/push`, contrôleur `push.controller.ts`)

| Méthode | Route | Auth | Rôle |
|---|---|---|---|
| `GET` | `/push/vapid-public-key` | publique | `{ publicKey }` pour l'abonnement navigateur |
| `POST` | `/push/subscribe` | JWT | `{ subscription: { endpoint, keys: { p256dh, auth } }, userAgent?, deviceLabel? }` → 201 `{ id }` (upsert par endpoint) |
| `DELETE` | `/push/subscribe` | JWT | `{ endpoint }` → 204 (idempotent) |
| `POST` | `/push/test` | JWT | push de test forcé (bouton « Tester ») |

## Événements critiques poussés (montants en XAF, formatés FCFA)

Client : `technician_en_route` (« Votre technicien est en route »),
`technician_arrived`, `quote_created` (« Nouveau devis reçu », montant),
`COMPLETED` (« Mission terminée, à valider »).
Technicien : `new_mission_available` (« Nouvelle mission disponible près de
vous »), `quote_accepted` / `quote_rejected`.

Format : `{ title, body, icon, badge, tag, data: { url, type } }` — `tag`
anti-doublons, `url` ouverte au clic. `icon`/`badge` :
`/brand/relio-mark.svg`.

## Comportement

- Abonnements : upsert par `endpoint`, `lastUsedAt` à jour, CASCADE avec
  le compte, désinscription idempotente.
- Envois : 410/404 → suppression silencieuse ; 413 → log ; autres → log,
  jamais de propagation vers le métier. `sendToUser()` ne lève jamais.
- Payloads et endpoints jamais journalisés (ids + compteurs seuls).
