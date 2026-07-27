# Whauto AI

SaaS de commerce conversationnel centré sur WhatsApp Business (Cloud API officielle Meta). Monorepo pnpm + Turborepo.

Modules implémentés : **fondations techniques**, **module Auth** (register, vérification email, login, refresh avec rotation, reset/changement de mot de passe, rate limiting Redis), **module Organizations** (multi-tenant : organisations, membres, invitations, RBAC, TenantContext, audit), **module Shops** (boutiques multi-org, boutique principale, statuts, horaires d'ouverture) et **frontend complet** de ces modules (Next.js App Router : auth, onboarding guidé, organisations, membres/invitations, boutiques et horaires). Voir `CLAUDE.md` pour les conventions et l'état d'avancement.

## Prérequis

- Node.js >= 22
- pnpm >= 9 (activé via `corepack enable`)
- Docker + Docker Compose

## Démarrage

```bash
# 1. Installer les dépendances
pnpm install

# 2. Builder les packages partagés (nécessaire avant le premier dev/typecheck)
pnpm build --filter="./packages/*"

# 3. Copier les variables d'environnement (racine + Prisma CLI)
cp .env.example .env
cp .env.example packages/database/.env   # Prisma cherche son .env relatif à packages/database
# apps/web/.env existe déjà (NEXT_PUBLIC_API_URL) — Next.js ne lit pas le .env racine

# 4. Générer le client Prisma
pnpm db:generate

# 5. Démarrer PostgreSQL + Redis
pnpm docker:up

# 6. Appliquer la migration initiale
pnpm db:migrate

# 7. Vérifier la connectivité à la base
pnpm db:seed

# 8. Démarrer toutes les apps en parallèle
pnpm dev
```

## Services

| Service | URL |
|---|---|
| Frontend (`apps/web`) | http://localhost:3000 |
| API (`apps/api`) | http://localhost:4000/api |
| Health check | http://localhost:4000/api/health |
| Prisma Studio | `pnpm db:studio` → http://localhost:5555 |
| PostgreSQL | localhost:5433 (remappé — un PostgreSQL natif occupe souvent le 5432 sur Windows) |
| Redis | localhost:6379 |

`apps/whatsapp-worker` ne sert aucune route HTTP — c'est un processus NestJS en mode application context (BullMQ consumer à terme).

## Commandes utiles

```bash
pnpm lint          # ESLint sur tout le monorepo
pnpm typecheck      # tsc --noEmit sur tout le monorepo
pnpm test           # tests unitaires (Jest pour api/worker, Vitest pour web/packages)
pnpm format         # Prettier --write

pnpm db:migrate      # nouvelle migration Prisma (dev)
pnpm db:studio       # Prisma Studio
pnpm docker:down     # arrêter Postgres + Redis

pnpm --filter @whauto/api test:e2e   # tests e2e de l'API (nécessite Postgres + Redis démarrés)

# Tests e2e navigateur (Playwright, Chromium) — nécessitent les BUILDS de l'API
# et du front (le mode dev de Next est incompatible : rebuilds continus) :
pnpm --filter @whauto/api build
pnpm --filter @whauto/web build
pnpm --filter @whauto/web test:e2e   # démarre l'API (env de test, Redis DB 1) + Next sur le port 3001
```

## Authentification

Endpoints sous `/api/auth` (Swagger : http://localhost:4000/api/docs) : `register`, `verify-email`, `resend-verification`, `login`, `refresh`, `logout`, `logout-all`, `me`, `forgot-password`, `reset-password`, `change-password`.

**Contrat client (apps/web) :**

- Le **refresh token** est un token opaque posé par l'API dans un cookie `HttpOnly` (`whauto_refresh`, `SameSite=Strict`, `Path=/api/auth`, host-only). Le client ne le voit jamais et ne doit jamais le manipuler — il suffit d'appeler `POST /api/auth/refresh` avec `credentials: 'include'`.
- L'**access token** (JWT, 15 min) est retourné dans le JSON de `login`, `refresh` et `change-password`. Il doit être conservé **en mémoire uniquement** (state/contexte), jamais dans `localStorage`/`sessionStorage`, et envoyé en header `Authorization: Bearer <token>`.
- Chaque refresh **fait tourner** le token (rotation) ; la réutilisation d'un ancien refresh token révoque toute la famille de sessions (anti-vol).
- `change-password` et `reset-password` révoquent toutes les sessions ; `change-password` en recrée une immédiatement (nouveaux tokens dans la réponse).

**Dev uniquement :** avec `NODE_ENV=development` et `AUTH_EXPOSE_TEST_TOKENS=true`, les liens de vérification/reset sont renvoyés dans le champ `devLink` des réponses (en plus du mock email console). Jamais actif hors development.

**Rate limiting :** compteurs Redis via `@nest-lab/throttler-storage-redis@1.2.0` (compatibilité vérifiée : peers `@nestjs/common|core ^11`, `@nestjs/throttler >=6`, `ioredis >=5`). Limites par endpoint configurées par paires `AUTH_RATE_LIMIT_*_MAX` / `AUTH_RATE_LIMIT_*_WINDOW_SECONDS` (voir `.env.example`).

## Organisations (multi-tenant)

Endpoints (Swagger : http://localhost:4000/api/docs) :

| Ressource | Endpoints |
|---|---|
| Organizations | `POST /organizations` · `GET /organizations` · `GET /organizations/:id` · `PATCH /organizations/:id` · `POST /organizations/:id/archive` |
| Membres | `GET /organizations/:id/members` · `PATCH /organizations/:id/members/:membershipId/role` · `DELETE /organizations/:id/members/:membershipId` · `POST /organizations/:id/leave` |
| Invitations | `POST` / `GET /organizations/:id/invitations` · `POST /organizations/:id/invitations/:invitationId/cancel` · `GET /invitations/mine` · `POST /invitations/accept` · `POST /invitations/decline` |

**Contrat tenant :** l'organisation active est désignée par le path param `:organizationId` (ou, pour les futurs modules à routes plates, le header `X-Organization-Id` — les deux présents et différents → 400). L'identifiant n'est **jamais** une preuve d'accès : le backend vérifie systématiquement le Membership ACTIVE en base ; un non-membre reçoit 404. La création d'organisation, la création d'invitation et l'acceptation exigent un email vérifié.

**Rôles** : OWNER (unique, garanti par index PostgreSQL, non transférable dans cette phase) > ADMIN > MANAGER > AGENT. Un acteur ne gère que des rôles strictement inférieurs au sien. Matrice complète : `apps/api/src/common/tenant/permissions.ts`.

**Invitations** : token opaque envoyé par email (mock console en dev — lien exposé en `devLink` avec `AUTH_EXPOSE_TEST_TOKENS=true`), expiration 7 jours (`INVITATION_EXPIRES_IN_DAYS`), usage unique, réinvitation = renouvellement du token sur la même invitation. Pagination des listes : `page`/`limit` (défauts 1/20, max 100) → `{ items, total, page, limit }`.

## Frontend (apps/web)

- **Authentification côté client** : access token en mémoire uniquement (jamais localStorage/sessionStorage), refresh token en cookie HttpOnly géré par l'API. Au chargement, `POST /auth/refresh` restaure la session ; un seul onglet rafraîchit à la fois (Web Locks + BroadcastChannel `whauto-auth`) et le logout se propage à tous les onglets. Refresh préventif ~60 s avant expiration.
- **Organisation active** : sélecteur dans la topbar, préférence en localStorage revalidée à chaque chargement contre l'API ; toutes les données sont rechargées au changement (aucun mélange entre tenants). Sans organisation → onboarding guidé (vérification email → organisation → première boutique).
- **Permissions UI** : l'interface masque/désactive les actions selon les permissions effectives retournées par `GET /organizations/:id` — la sécurité reste entièrement backend.
- **Production** : le cookie refresh est `SameSite=Strict` host-only — l'app et l'API doivent partager le même domaine enregistrable (ex. `app.whauto.ai` / `api.whauto.ai`).

## Boutiques (Shops)

Endpoints sous `/api/organizations/:organizationId/shops` (Swagger : http://localhost:4000/api/docs) :

| Action | Endpoint |
|---|---|
| CRUD | `POST /shops` · `GET /shops` (pagination, `search` insensible à la casse, filtres `status`/`businessType`/`isPrimary`/`includeArchived`, tri) · `GET /shops/:shopId` · `PATCH /shops/:shopId` |
| Statut | `POST .../activate` · `POST .../deactivate` · `POST .../archive` (terminal) |
| Principale | `POST .../set-primary` (idempotent, une seule principale garantie par index PostgreSQL) |
| Horaires | `GET .../opening-hours` · `PUT .../opening-hours` (remplacement complet) |

Points clés :
- slug unique **par organisation** (deux organisations peuvent utiliser le même slug) ;
- la première boutique créée devient automatiquement principale ; l'archivage d'une principale promeut la plus ancienne ACTIVE (sinon INACTIVE, sinon DRAFT) ;
- `countryCode` (ISO alpha-2) requis à la création ; timezone/devise/locale héritées de l'organisation si absentes, validées strictement ;
- **convention PATCH** : champ absent = inchangé, `null` = effacement d'un champ optionnel ; `status`/`isPrimary` passent uniquement par les routes dédiées ;
- horaires : plusieurs plages par jour (`HH:mm`), jour fermé = zéro plage, pas de plage traversant minuit ;
- boutique archivée : lecture seule, exclue des listes par défaut (`includeArchived=true` pour l'inclure).

## Structure

```
apps/
  api/                 NestJS — API REST (port 4000)
  web/                 Next.js App Router (port 3000)
  whatsapp-worker/     NestJS application context — traitements asynchrones

packages/
  database/            Prisma (schema, migrations, client)
  shared/               Erreurs métier, constantes partagées
  config/               Validation Zod des variables d'environnement
  eslint-config/        Configuration ESLint partagée (flat config)
  tsconfig/             Configurations TypeScript partagées
```
