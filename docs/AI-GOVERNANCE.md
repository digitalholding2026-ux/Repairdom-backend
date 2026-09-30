# Relio — Gouvernance IA (IA-1 → IA-9)

> Chantier IA-10 — audit et garde-fous. Ce document décrit l'existant vérifié
> en code, pas une politique inventée. Tout point non tranché figure en
> section « Décisions » avec son statut (IMPLEMENTÉ / À VALIDER / À DÉCIDER).
> Aucune nouvelle fonctionnalité métier IA n'est ajoutée par IA-10.

## 1. Architecture

```text
Relio (NestJS)
  ↓  (services métier, jamais le frontend)
AI Gateway (IA-1 : AiGatewayService, seul appelant OpenRouter)
  ↓  POST {baseUrl}/chat/completions (OpenAI-compatible, HTTPS exigée)
OpenRouter (modèle configurable via OPENROUTER_MODEL)
  ↓  résultat JSON structuré et validé (jamais de texte libre exploité)
stockage du signal (tables IA-4 → IA-8, snapshots immuables)
  ↓
Dashboard Admin (IA-9 : visualisation + filtres + pagination)
  ↓
revue humaine (REVIEWED / DISMISSED / revue warning)
  ↓
Humain décide — l'IA ne devient jamais l'autorité décisionnelle.
```

Principes : AI-assisted, human oversight, fail-open, data minimization,
auditability, **no automatic sanctions**.

## 2. Matrice des flux IA-1 → IA-9 (état vérifié)

| Chantier | Objectif | Données transmises au modèle | Résultat | Stockage | Rôle humain | En cas d'échec |
|---|---|---|---|---|---|---|
| IA-1 Gateway | Socle d'appel OpenRouter | Messages passés par l'appelant (jamais de collecte propre) | Texte / JSON | Aucun | — (infra) | Exception typée (`AI_DISABLED`, `AI_UPSTREAM`, `AI_TERMINAL`, `AI_INVALID_RESPONSE`), jamais de retry |
| IA-2 Catalogue/barèmes | Référentiel tarifaire admin | Aucun appel IA | Barème versionné | `Pricing` + `PricingHistory` | Admin saisit les barèmes | N/A (pas d'IA) |
| IA-3 Diagnostic libre | Diagnostic technicien (texte/audio) | Texte saisi ; audio conservé en bucket privé, **jamais envoyé brut** | Diagnostic métier | `Diagnostic` (+ `audioStoragePath` privé) | Technicien auteur | N/A (pas d'analyse) |
| IA-4 Classification | Aider le dispatch (« Autre ») | `deviceLabel`, `description` (≤ 1000), `city`, natures de médias (jamais de bytes) | `{domainId?, categories[], confidence, classification}` | `DemandeClassification` (1/demande, `model`, `promptVersion v1`, `reason` borné) | Dispatch aidé, jamais décidé ; donnée client jamais écrasée | Fallback `UNCERTAIN`/`UNCLASSIFIABLE` tracé, création de demande intacte |
| IA-5 Mapping | Rapprocher diagnostic libre ↔ catalogue | Texte diagnostic (≤ 2000) + recommandation/justification/notes (≤ 500), présence d'audio (booléen, jamais transcrit ni envoyé), noms des diagnostics candidats | `{catalogDiagnosticId?, confidence, classification}` | `DiagnosticCatalogMatch` (1/diagnostic, `model`, `promptVersion v1`, `reason` borné) | Analytique seule ; diagnostic libre = vérité | Fallback `UNCERTAIN`/`UNMATCHED` tracé, diagnostic/devis intacts |
| IA-6 Pricing | Surveiller prix ↔ barème | **Aucun appel LLM** (comparaison entière déterministe) | `NORMAL/ABOVE_MAX/BELOW_MIN/UNCERTAIN/NO_BAREME` + écarts | `QuotePricingCheck` (1/devis, snapshot min/ref/max figé) | Aucune (signal) | N/A — fonctionne IA coupée |
| IA-7 Warnings | Avertir le technicien (écart barème) | **Aucun appel LLM** (comptage + délais déterministes) | `AiWarning` `PENDING/JUSTIFIED/REVIEWED` (+`EXPIRED` dérivé) | `AiWarning` (1/contrôle, justification horodatée, revue) | Technicien justifie (48 h) ; admin examine | Best-effort (jamais levé vers le métier) |
| IA-8 Conversations | Signaler anomalies d'échanges | Message courant + ≤ 10 messages récents (tronqués ≤ 1000, rôles seuls), mission (référence/catégorie/statut), diagnostic résumé (≤ 500), devis (montants/statuts) | `{flagged, category, confidence, severity, reason≤500}` | `AiConversationFlag` (1/message, `model`, `promptVersion v1`) | Admin examine (`REVIEWED`/`DISMISSED`) ; client/technicien jamais notifiés | Aucun flag, message intact, warn serveur |
| IA-9 Dashboard | Visualiser + examiner | **Aucun appel LLM** (agrégation de signaux existants) | Compteurs + listes paginées | Aucun (lecture seule) | Admin observe/examine/décide | Accessible IA coupée |

## 3. Données explicitement exclues des appels IA (§5 vérifié)

Quel que soit le chantier, ne sont **jamais sélectionnés ni transmis** :
mots de passe, JWT/tokens, clés API, coordonnées bancaires, téléphone,
email, adresse précise, GPS, données KYC, soldes, payouts, secrets.
Vérifié en code (`select` Prisma minimaux + test `ai-conversation-watch.spec.ts`
« minimisation » + nouveau `ai-governance.spec.ts`) et par revue des prompts
IA-4/IA-5 (champs nommés uniquement).

## 4. Secrets

- `OPENROUTER_API_KEY` : backend uniquement (`AiConfig.apiKey`), transmise en
  en-tête `Authorization` sortant, **jamais** dans le corps de requête, les
  logs (expurgée par `scrubSecrets`), les réponses API, le frontend ou le
  bundle Next.js (testé : aucune occurrence `OPENROUTER`/`sk-or-` dans `src/`).
- Modèle : toujours `AiConfig.model` (donc `OPENROUTER_MODEL`, défaut
  `openai/gpt-4o-mini`) ; **aucun service ne surcharge `model:`** (testé
  statiquement). Le modèle effectif est persisté par signal (`model`).
- Aucune nouvelle clé, aucun secret frontend (testé).

## 5. Logs (§6 vérifié)

Journalisé (ids + technique) : `caller`, `model`, `messages` (compte),
`status`, `durationMs`, `tokens`, `detail` (motif de refus / statut HTTP /
nom du modèle), `correlationId` (id demande/message), catégorie, confiance,
sévérité. Jamais : prompts/contenus, conversations intégrales, PII, clé,
`Authorization`, tokens.

## 6. Fail-open (§8 vérifié)

`AI_DISABLED`, timeout, 429/5xx, 4xx, JSON invalide, réponse incohérente,
confiance < seuil → **fonction métier intacte, aucun flag/sanction/blocage,
aucune modification automatique**. Couverture : specs IA-4/IA-5/IA-8
(désactivé, timeout, upstream, terminal, invalide, confiance) + IA-6/IA-7
(déterministes, best-effort `try/catch`, `P2002` → relecture).

## 7. Confiance (§9)

`confidence` ∈ [0, 1], clampée à l'écriture, seuils centralisés
(`AI_CLASSIFICATION_MIN_CONFIDENCE`, `AI_CHAT_MIN_CONFIDENCE`, défaut 0.7).
Présentation admin factuelle (« confiance : 0,82 », « Confiance du modèle »),
**jamais** « Fraude : 82 % » ni probabilité de culpabilité (vérifié dans les
vues IA-9 + test frontend `ai-dashboard-helpers.test.ts`).

## 8. IA-7 — niveaux (§10 vérifié)

`surveillanceLevelForCount` : 0/1/2/3 (seuils 1/2/4 centralisés). Niveau 3 =
« réexamen humain requis », **aucun effet automatique** (pas de suspension,
bannissement, blocage, retrait de missions — vérifié : le service ne touche
ni devis, ni ledger, ni statuts). Dashboard : `humanReviewRequired` + texte
factuel.

## 9. IA-8 — catégories (§11 vérifié)

Les 7 catégories sont des **libellés de signal** (le prompt exige contexte,
proportion, descriptions factuelles ; une simple mention ne suffit pas).
`HIGH` = priorité de revue, jamais fraude confirmée. Revue humaine
(`REVIEWED`/`DISMISSED`) obligatoire avant toute conclusion.

## 10. Prompts (§17 vérifié)

Chaque analyse LLM possède `promptVersion` persisté (`v1` IA-4/IA-5/IA-8),
`model` persisté, `createdAt`. IA-6/IA-7 : déterministes, sans prompt
(non concernées). Toute évolution future = **nouvelle version explicite**,
jamais de réécriture silencieuse ni de recalcul des anciens signaux.

## 11. Conservation — état actuel (§14)

| Donnée | Utilité | Durée actuelle | Raison | Suppression possible |
|---|---|---|---|---|
| `DemandeClassification` | Audit dispatch + traçabilité IA-4 | **Illimitée (pas de purge)** | Historique immuable lié à la demande | Avec la demande (Cascade) |
| `DiagnosticCatalogMatch` | Audit mapping + source IA-6 | **Illimitée** | Traçabilité analytique | Avec le diagnostic (Cascade) |
| `QuotePricingCheck` | Preuve du barème au moment du devis | **Illimitée** | Preuve tarifaire opposable | Avec le devis (Cascade) |
| `AiWarning` | Historique disciplinaire potentiel + preuve 48 h | **Illimitée** | Audit surveillance | Avec technicien/demande/devis (Cascade) |
| `AiConversationFlag` | Audit modération | **Illimitée** | Audit surveillance | Avec demande/message/expéditeur (Cascade) |
| Logs IA applicatifs | Diagnostic technique | **Durée du log provider (Railway)** | Exploitation | Rotation provider |

Aucune purge automatique n'existe. **À DÉCIDER** : durées de rétention
cibles par table (proposition à valider §13 : aligner sur la durée de vie
de la mission + X mois d'audit — X non fixé ici).

## 12. Suppression / anonymisation (§15 — analyse, sans implémentation)

- Compte **sans dépendance** : suppression physique → les signaux liés en
  Cascade disparaissent avec lui (cohérent : plus d'historique à protéger).
- Compte **avec dépendances** : désactivation logique (`isActive=false`) →
  tout l'historique IA est conservé (audit préservé, connexion bloquée).
- Suppression d'une **demande** : Cascade sur classification, checks,
  warnings (`demandeId`), flags, messages (+ flags via `messageId`).
- `reviewedBy` : `SetNull` (la revue survit au départ du reviewer).
- Ledger financier : `Restrict` (jamais impacté par l'IA).
- **À DÉCIDER** : anonymisation (remplacement contenus/justifications par
  `[supprimé]`) vs conservation brute après clôture + délai ; ne pas casser
  l'audit financier ni les preuves tarifaires.

## 13. Revue humaine (§16)

```text
Signal IA → lecture ADMIN (guards existants) → revue → REVIEWED / DISMISSED
(+ revue warning IA-7) → Humain décide.
```

Deux mécanismes conservés (warnings tarifaires, flags conversationnels),
**aucun troisième système créé**. `reviewedBy`/`reviewedAt`/`reviewNote`
persistés, signal jamais supprimé.

## 14. Confidentialité — audit du document actuel (§13)

Document : `frontend/src/app/conditions-utilisation/page.tsx` §9 « Données
personnelles » (3 phrases génériques).

| Sujet | Statut |
|---|---|
| Collecte nom/adresse/téléphone/email, usage plateforme, non-revente | EXISTANT |
| Recours à un prestataire IA (OpenRouter) pour l'analyse | **MANQUANT** |
| Finalités (sécurité, support, qualité, aide au dispatch) | **MANQUANT** |
| Catégories de données analysées (diagnostics, messages, tarifs…) | **MANQUANT** |
| Conservation (durées, suppressions en cascade) | **MANQUANT** |
| Destinataires / sous-traitants | **MANQUANT** |
| Droits utilisateurs (accès, rectification, suppression, revue humaine) | **MANQUANT** |
| Absence de décision automatisée irréversible | **MANQUANT** |
| Contact données | **MANQUANT** |
| Toute formulation juridique des points ci-dessus | **À VALIDER JURIDIQUEMENT** (non rédigé ici) |

## 15. Décisions

### IMPLEMENTÉ (IA-10)

- Matrice des flux, exclusions PII, règles de logs/secrets/modèle, fail-open,
  présentation factuelle de la confiance, niveaux IA-7 non bloquants,
  catégories IA-8 non accusatoires, prompts versionnés, analyse
  conservation/suppression, audit confidentialité, revue humaine documentée.
- Notice courte d'information dans l'espace conversation
  (`ConversationSection`, client + technicien, Desktop + Mobile).
- Tests `ai-governance.spec.ts` (secrets, modèle, PII, logs, fail-open,
  anti-sanction) + assertions frontend (`ai-dashboard-helpers.test.ts`,
  `ai-classification.test.ts`, `diagnostic-libre.test.ts` : aucune référence
  IA exposée côté produit).

### À VALIDER (juridique / produit, non implémenté)

- Formulation confidentialité : prestataire IA, finalités, catégories,
  conservation, sous-traitants, droits, non-décision automatisée, contact.
- Durées de rétention cibles par table IA + logs.
- Stratégie suppression vs anonymisation après clôture.

### À DÉCIDER (technique, refusé par défaut en IA-10)

- Purge/rotation automatique (non créée) ; queue dédiée si volume (non créée,
  §34 IA-8 maintenu) ; score global (interdit) ; sanction automatique
  (interdite) ; modification des signaux pour l'affichage (interdite).
