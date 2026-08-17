# Readiness App Review Meta — Whauto AI (P1-G10)

Ce document rassemble ce qui est nécessaire pour soumettre l'application Meta à l'App
Review / Business Verification pour l'intégration WhatsApp Business Platform (Embedded
Signup multi-tenant). Il distingue ce qui est **prêt côté code** de ce qui reste
**manuel/externe** (soumission Meta, vérification d'entreprise, contenus légaux).

## 1. Permissions demandées

| Permission | Usage réel dans Whauto |
|---|---|
| `whatsapp_business_messaging` | Envoi/réception de messages (webhook + outbound worker) |
| `whatsapp_business_management` | Lecture du numéro, gestion du profil WhatsApp Business, abonnement webhooks |
| `business_management` | Requise par l'Embedded Signup pour accéder aux assets business (à confirmer selon la config de l'App) |

Les scopes stockés à l'onboarding (`meta_whatsapp_credentials.scopes`) reflètent ce que
l'App demande. Ne demander **que** ces permissions — pas de scope superflu.

## 2. Configuration technique (prête)

- **Embedded Signup** : bouton « Connecter mon WhatsApp Business » (frontend) → SDK Meta
  → `code` échangé **côté serveur uniquement** → provisioning (`POST .../meta/embedded-signup`).
  Le secret d'App ne vit jamais côté frontend.
- **Webhook** : `GET/POST /api/webhooks/whatsapp/meta` — vérification `hub.verify_token`
  (timing-safe) et réception signée HMAC-SHA256 (App Secret = autorité unique),
  multi-tenant (routage par `phone_number_id`).
- **Tokens** : chiffrés au repos (AES-256-GCM, `@whauto/crypto`), jamais exposés/logués.
- **Isolation multi-tenant** : prouvée e2e (`test/meta-multitenant.e2e-spec.ts`).

### Callbacks d'App Review (prêts)

| Callback | URL | Comportement |
|---|---|---|
| Deauthorize | `POST /api/webhooks/whatsapp/meta/deauthorize` | Vérifie le `signed_request` → démantèle les connexions du user + révoque ses tokens |
| Data Deletion | `POST /api/webhooks/whatsapp/meta/data-deletion` | Vérifie le `signed_request` → révoque les credentials Meta du user, trace la demande, renvoie `{ url, confirmation_code }` |
| Statut suppression | `GET /api/webhooks/whatsapp/meta/data-deletion/status?code=…` | URL publique de suivi renvoyée ci-dessus |

Le `signed_request` (HMAC-SHA256 base64url avec l'App Secret) est vérifié en temps
constant ; signature invalide → 401, aucune action. Le rattachement au commerçant se fait
par l'ID utilisateur Facebook capturé à l'onboarding (`meta_whatsapp_credentials.facebookUserId`).

### Variables d'environnement à renseigner (prod)

- `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`
- `META_MULTI_TENANT_ENABLED=true`, `SECRETS_ENCRYPTION_KEY` (32 octets base64)
- `API_PUBLIC_URL` (base des URLs de callback/statut)
- `PRIVACY_POLICY_URL`, `TERMS_URL` (URLs publiques finales)
- Frontend : `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_CONFIG_ID`

### URLs à déclarer dans le dashboard Meta

- Webhook : `https://<API_PUBLIC_URL>/api/webhooks/whatsapp/meta` (+ verify token)
- Deauthorize callback : `https://<API_PUBLIC_URL>/api/webhooks/whatsapp/meta/deauthorize`
- Data Deletion callback : `https://<API_PUBLIC_URL>/api/webhooks/whatsapp/meta/data-deletion`
- Privacy Policy : `https://<app>/privacy` — Terms : `https://<app>/terms`

## 3. Instructions de test pour le reviewer (à joindre à la soumission)

1. Se connecter à Whauto AI (identifiants de test fournis séparément).
2. Créer/ouvrir une boutique, aller dans l'inbox WhatsApp.
3. Cliquer « Connecter mon WhatsApp Business » → suivre l'Embedded Signup Meta.
4. Envoyer un message depuis un WhatsApp autorisé vers le numéro connecté → il apparaît
   dans l'inbox ; répondre depuis Whauto → réception côté client.
5. Modifier le profil WhatsApp depuis Paramètres boutique.
6. Déconnecter le canal → la connexion est révoquée.

## 4. Étapes MANUELLES / EXTERNES (hors code — à réaliser par l'équipe)

- [ ] **Business Verification** Meta (documents légaux de l'entreprise).
- [ ] Renseigner **App ID + Config ID** réels de l'Embedded Signup.
- [ ] Héberger et renseigner les **URLs finales** Privacy Policy / Terms (pages de départ
      fournies dans `apps/web` — à faire **valider juridiquement**).
- [ ] Fournir un **screencast** de démonstration + **identifiants de test** reviewer.
- [ ] Renseigner les **URLs de callback** ci-dessus dans le dashboard Meta.
- [ ] **Soumettre** l'App Review depuis le dashboard Meta.

## 5. Vérifications de non-régression (code)

- `packages/whatsapp` : `meta-signed-request.test.ts` (vérification signed_request).
- `apps/api` : `test/embedded-signup.e2e-spec.ts` (onboarding + capture facebookUserId +
  deauthorize + data-deletion + statut), `test/meta-multitenant.e2e-spec.ts` (isolation).
