# Plan détaillé — Sous-phase C : AUTO_REPLY (limité)

> Document de **planification uniquement** — aucun code n'est écrit tant que le périmètre
> et les décisions structurantes (§3) ne sont pas validés. Méthode : module par module,
> chaque groupe validé avant le suivant.
>
> Prérequis atteint : sous-phase B (SUGGEST_ONLY) livrée et **validée en réel** le 2026-07-27
> (voir `docs/TEST-DATA-PILOT.md`). AUTO_REPLY est donc débloquable, mais non démarré.

---

## 1. Objectif

Permettre à l'IA de **répondre automatiquement au client**, sans validation humaine préalable,
**dans un périmètre étroit et sûr**, avec **escalade systématique au moindre doute** et
**reprise humaine instantanée**.

Différence avec la sous-phase B :

| | SUGGEST_ONLY (B, livré) | AUTO_REPLY (C, ce plan) |
|---|---|---|
| Qui envoie ? | Un humain, d'un clic | L'IA elle-même |
| Sortie de l'orchestrateur | `AiSuggestion PENDING` | Envoi direct **ou** escalade |
| Filet de sécurité | La relecture humaine | Des garde-fous automatiques |

## 2. Principes intangibles (hérités du cahier des charges)

1. **Défaut = ne pas envoyer.** AUTO_REPLY n'envoie *que* si tous les feux sont verts ; sinon il escalade.
2. **L'IA n'est jamais source de vérité** sur prix / stock / commandes / paiements — elle ne peut
   affirmer que ce que les **outils métier déterministes** lui ont réellement renvoyé dans ce run.
3. **Réversibilité totale** : un humain reprend la main à tout instant ; l'auto-reply se coupe pour
   cette conversation.
4. **Traçabilité** : chaque message auto est marqué (IA, run, modèle), audité sans jamais logguer le texte.
5. **Réutilisation** : on ne réécrit rien de B — même provider Gemini, mêmes outils lecture seule,
   même validation structurée + sémantique, même flux d'envoi (outbox → worker → provider).

---

## 3. Décisions structurantes à trancher (⚠️ avant tout code)

### D1 — Où s'exécute l'envoi automatique ?
La décision d'envoi appartient au worker (`AiOrchestratorService`). Or la création transactionnelle
`Message OUTBOUND PENDING + OutboxEvent + maj Conversation` vit aujourd'hui côté API
(`MessagesService.createOutboundInTx`).
- **Option A (recommandée)** : répliquer ce chemin dans un service *worker* partagé (mêmes invariants :
  fenêtre 24 h autorité finale, idempotence `dispatchId`, un seul message, un seul outbox). Réutilise le
  processor outbound existant → **un seul chemin physique d'envoi** vers le provider.
- Option B : le worker publie un événement que l'API consomme pour créer l'outbound → couplage et
  latence inutiles.
➡️ **Reco : A.**

### D2 — Anti-boucle / fréquence
- Jamais deux réponses auto **consécutives** sans nouveau message client entre-temps (pas de monologue IA).
- Plafond de N réponses auto par conversation et de M par fenêtre de temps.
- Le debounce `ai.debounce.<conversationId>` (déjà en place) reste la première barrière.
➡️ À fixer : valeurs de N et M (proposition : pas de 2ᵉ auto sans réponse client ; max ~5/conversation/jour).

### D3 — Critères d'auto-envoi vs escalade (le cœur du dispositif)
L'IA a le droit d'**envoyer seule** uniquement si **TOUTES** ces conditions sont réunies :
1. Décision structurée = `SUGGEST_REPLY` (ni `HANDOFF`, ni `NO_REPLY`).
2. Validation sémantique = `CONSISTENT` (ni `FORCE_HANDOFF`, ni `INVALID_OUTPUT`) — déjà implémentée en B.
3. Toute affirmation prix/stock/horaires/commande est **adossée à un outil réellement appelé** dans ce run
   (`usedBusinessData` cohérent avec les `AiToolCall`).
4. Intention dans une **liste blanche** de catégories sûres (question produit, disponibilité, horaires,
   statut de commande vérifié par les 4 clés).
Sinon → **escalade** (`ConversationHandoff REQUESTED`, déjà en place) + notification agents, **aucun envoi**.
➡️ À trancher : une réponse « pas assez sûre » produit-elle **(a)** un simple handoff, ou **(b)** un handoff
   **+** une `AiSuggestion PENDING` pour aider l'agent ? (Reco : b — l'agent gagne du temps sans risque.)

### D4 — Périmètre & fenêtre Meta
- Activation **par Shop** : `AiConfiguration.mode = AUTO_REPLY` + permission `ai.enableAutoReply` (OWNER/ADMIN, déjà existante).
- **Fenêtre 24 h Meta fermée** : un texte libre est interdit par Meta hors fenêtre → sans module Templates
  (non implémenté, backlog), **AUTO_REPLY ne peut pas envoyer** fenêtre fermée → il escalade/attend.
  C'est une **limite assumée** de la phase.
➡️ À trancher : auto-reply **24/7** ou **restreint hors heures d'ouverture** (relais quand aucun agent) ?

### D5 — Mode de conversation
`Conversation.mode` (HUMAN par défaut ; AI/HYBRID réservés). AUTO_REPLY doit basculer la conversation en
**AI**, et toute action humaine (réponse manuelle) la repasse en **HUMAN** en suspendant l'auto-reply.
➡️ À trancher : définir précisément HYBRID (ex. l'IA propose *et* peut envoyer les cas très sûrs, escalade le reste) ou le laisser hors scope de C.

### D6 — Reprise humaine & coupe-circuits
- Réponse manuelle d'un agent → conversation **HUMAN**, auto-reply suspendu pour cette conversation.
- **Kill switch global** (`AI_MODE=DISABLED`) et **par Shop** (config) — déjà respectés par l'ordre de priorité existant.
- **Pause auto-reply par conversation** (bouton) → nouvel état à prévoir.

### D7 — Marquage & audit
- Message OUTBOUND émis par l'IA : `aiRunId` + flag `isAiGenerated` sur `Message`.
- Audit : `AI_AUTO_REPLY_SENT`, `AI_AUTO_REPLY_ESCALATED`, `AI_AUTO_REPLY_SUPPRESSED` (jamais le texte).
- Temps réel : le message auto apparaît dans l'inbox marqué « envoyé par l'IA ».

---

## 4. Découpage en groupes (validés un par un)

- **C0 — Décisions & modèle (aucun envoi).** Trancher D1–D7. Migrations Prisma **additives** :
  `Message.isAiGenerated`/`aiRunId` (si absents), bornes auto-reply dans `AiConfiguration`
  (max/jour, catégories autorisées, respect des horaires), état de pause par conversation, enum d'audit
  `AI_AUTO_REPLY_*`. Aucune logique d'envoi.
- **C1 — Chemin d'envoi worker (sans décision auto).** Service worker de création outbound transactionnelle
  (réplique fidèle de `createOutboundInTx` : Message PENDING + OutboxEvent + Conversation, fenêtre 24 h
  autorité, idempotence `dispatchId`). Testé isolément, **pas encore branché** à la décision IA.
- **C2 — Décision & garde-fous.** Dans l'orchestrateur, après génération+validation : module de décision
  AUTO_REPLY (gate stricte D3 + anti-boucle D2 + fenêtre/horaires D4) → `ENVOYER` / `ESCALADER` / `NE_RIEN_FAIRE`.
  Revérification d'obsolescence **sous verrou Conversation** avant l'envoi (mécanisme déjà éprouvé en B).
- **C3 — Bascule de mode & reprise humaine.** Conversation → AI quand auto-reply agit ; action humaine →
  HUMAN + suspension ; pause par conversation ; kill switches.
- **C4 — API + permissions + audit.** Activation via config (permission `ai.enableAutoReply` déjà là),
  endpoints pause/reprise, audit `AI_AUTO_REPLY_*`, DTO filtrés (jamais clé/prompt/payload).
- **C5 — Frontend.** Badge « L'IA répond automatiquement », messages IA marqués (violet #7C3AED),
  bouton pause/reprise, indicateur d'escalade, réglages Shop (bornes, horaires, catégories).
- **C6 — Tests.** e2e API (envoi auto en conditions sûres ; escalade sur affirmation non sourcée ;
  anti-boucle ; fenêtre fermée = pas d'envoi ; reprise humaine suspend ; **un seul** message+outbox ;
  kill switch) ; intégration worker (décision + envoi transactionnel) ; Playwright (badge/marquage/pause) ;
  puis **test réel manuel final** sous confirmation explicite (jamais d'envoi réel sans accord).

---

## 5. Risques & dépendances

| Risque | Mitigation |
|---|---|
| **Réponse erronée envoyée au vrai client** | Gate stricte D3, escalade par défaut, reprise instantanée, bornes anti-boucle |
| **Fenêtre 24 h fermée** (texte libre interdit) | Pas d'envoi auto → escalade ; dépend du futur module **Templates** (backlog) |
| **Boucle IA / spam** | Anti-boucle D2 obligatoire (pas de 2ᵉ auto sans réponse client) |
| **Double envoi** (réseau) | `dispatchId` + outbox déjà éprouvés ; limite Meta documentée (pas d'idempotence externe) |
| **Concurrence humain ↔ IA** | Verrou Conversation + revérification d'obsolescence avant envoi (déjà en place) |
| **Coût / quota Gemini** | Plus d'appels ; 429 déjà classifié QUOTA (run relâché, pas de perte) |

## 6. Fichiers principalement concernés (indicatif)

- `packages/ai/` : réutilisé tel quel (provider, outils, validation) ; éventuelle variante de prompt AUTO_REPLY versionnée.
- `apps/whatsapp-worker/src/ai/` : `ai-orchestrator.service` (branche décision), **nouveau** service de décision
  auto-reply + service d'envoi outbound worker, `ai-trigger` (mode).
- `apps/api/src/modules/ai/` : `ai-configuration.service` (bornes), endpoints pause/reprise ;
  `conversations/messages.service` (part partagée de l'envoi).
- `packages/database/prisma/` : migrations additives (C0).
- `apps/web/` : UI conversation (badge, marquage, pause) + réglages Shop.
- `apps/api/src/common/tenant/permissions.ts` : `ai.enableAutoReply` déjà présent.

## 7. Ce qu'il faut valider pour lancer C0

Les arbitrages **D1–D7** (surtout **D3** = critères d'auto-envoi, **D4** = 24/7 vs hors-heures,
et le choix handoff seul vs handoff + suggestion). Une fois ces points tranchés, C0 (modèle + migrations
additives, sans envoi) peut démarrer.
