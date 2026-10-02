# Temps réel — socle SSE (serveur → client)

> Unidirectionnel serveur → client, compatible CDN/proxies, sans WebSocket.
> Le polling frontend existant reste en fallback (voir frontend, partie B).

## Channels

| Channel | Abonnés | Usage |
|---|---|---|
| `user:<userId>` | `GET /realtime/user` (CLIENT, TECHNICIAN, ADMIN) | Notifications personnelles + signaux destinés à l'utilisateur |
| `mission:<demandeId>` | `GET /realtime/missions/:demandeId` (client propriétaire OU technicien assigné, sinon 403) | Chat, statuts, GPS technicien de la mission |
| `technician:available` | `GET /realtime/technician/stream` (TECHNICIAN, + `user:<id>`) | Nouvelles missions disponibles, missions prises |

## Événements et payloads (montants en XAF entiers, jamais formatés)

| Type | Channel | Payload |
|---|---|---|
| `mission.status_changed` | `mission:<id>` | `{ demandeId, fromStatus, toStatus, scheduledAt \| null }` |
| `mission.technician_en_route` | `mission:<id>` | `{ demandeId, technicianId, hasPosition }` |
| `mission.technician_arrived` | `mission:<id>` | `{ demandeId, technicianId, latitude \| null, longitude \| null }` |
| `mission.message_created` | `mission:<id>` | `{ id, content, senderId, sender, createdAt }` (message API) |
| `mission.technician_position` | `mission:<id>` | `{ demandeId, technicianId, latitude, longitude }` (remplace la précédente, aucun historique) |
| `technician.new_mission_available` | `technician:available` + `user:<id>` | `{ demandeId, reference, category, city }` — le consommateur revalide l'éligibilité via le détail (403/404 → ignoré) |
| `technician.mission_taken` | `mission:<id>` + `technician:available` | `{ demandeId, technicianId }` |
| `mission.quote_created` | `mission:<id>` | `{ quoteId, amount (XAF), currency, description, source, diagnosticId }` |
| `mission.quote_accepted` / `mission.quote_rejected` | `mission:<id>` | `{ quoteId, amount (XAF), currency, status }` |
| `mission.negotiation_requested` | `mission:<id>` | `{ quoteId, requestedBy }` |
| `notification.created` | `user:<id>` | `{ demandeId, kind }` (la liste est refaite en fetch) |

Format fil : `event: <type>\ndata: {"type","channel","payload","emittedAt"}\n\n`
(+ commentaire `: connected` à l'ouverture, `: ping` toutes les 25 s).

## Reconnexion attendue côté client

Backoff exponentiel 1s → 2s → 4s → 8s → 16s → 30s (plafond), reset après
30 s de connexion stable. Après 5 échecs consécutifs : bascule en polling
fallback (flag `mode: 'sse' | 'polling' | 'offline'`, toast discret).
**Aucun message perdu** : le backend garde l'historique (messages, devis,
statuts, notifications en base) — à la reconnexion le client refait un
fetch et se resynchronise. L'événement SSE est un signal, jamais la seule
source de vérité.

## Ping et cleanup

- Ping `: ping` toutes les 25 s à toutes les connexions (timeouts proxies
  Railway/Cloudflare). Ping en échec = socket morte → désinscription.
- Cleanup sur `req.on('close')` (+ log warn sur `error`). Arrêt module :
  intervalles nettoyés, connexions fermées.
- Quota : max 3 connexions simultanées par utilisateur (la plus ancienne
  est fermée). Backpressure : `res.write() === false` → abandon compté
  (jamais empilé), log si > 10/min.
- `publish()` ne lève jamais et ne journalise jamais les payloads
  (PII : contenus de messages, positions GPS) — ids, types et compteurs seuls.
- Publication hors transaction : les services publient APRÈS commit
  (jamais d'événement fantôme en cas de rollback).

## Écarts assumés vs spec initiale

- `technician.updateLocation` (position du **profil**, sans mission) :
  aucun événement — pas de contexte mission, aucun consommateur.
  Le GPS mission passe par `startTravel` / `refreshTravelLocation` /
  `markArrived` (événements dédiés).
- `technician.new_mission_available` est diffusé sur le channel partagé :
  le consommateur DOIT revalider l'éligibilité (détail → 403/404 = ignorer).
