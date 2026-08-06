# Procédure — Test Mobile Money RÉEL Genius Pay (manuel)

> ⚠️ **Manuel uniquement, jamais automatisé.** Ne jamais lancer un paiement réel
> sans intention explicite. Ne jamais committer ni afficher les secrets Genius
> Pay. Toujours commencer en **sandbox** (`pk_sandbox_…`) avant le **live**.

Cette procédure valide de bout en bout : `CreditPackage → TopUp → Genius Pay →
paiement Mobile Money → webhook signé vérifié → creditTopUp() → Wallet crédité →
wallet.balance.updated → IA de nouveau éligible`. Tout le flux est déjà couvert
par les tests locaux (faux serveur Genius Pay) ; ce test confirme uniquement
l'intégration avec le vrai agrégateur.

## 0. Prérequis
- Un **compte marchand Genius Pay** actif (dashboard `pay.genius.ci`).
- Les clés marchand **sandbox** puis **live** : `pk_…`, `sk_…`.
- Un **secret de webhook dédié** `whsec_…` (généré à la création du webhook dans
  le dashboard — visible une seule fois, à stocker en lieu sûr).
- Un **numéro Mobile Money** valide pour un opérateur supporté (Orange, MTN, Moov…).
- Un **tunnel public** vers l'API locale (ex. `ngrok http 4000`) — Genius Pay doit
  pouvoir POSTER le webhook sur une URL publique HTTPS.
- L'app web accessible pour la redirection de retour (tunnel ou déploiement).

## 1. Configuration `.env` (jamais `.env.example`)
Renseigner UNIQUEMENT dans `.env` (non commité) :

```
PAYMENT_PROVIDER=GENIUS_PAY
GENIUS_PAY_API_KEY=<clé publique sandbox puis live>
GENIUS_PAY_SECRET_KEY=<clé secrète>
GENIUS_PAY_WEBHOOK_SECRET=<secret whsec_ du webhook>
# Base API : défaut https://pay.genius.ci/api/v1 (sandbox/live dérive du préfixe de clé)
GENIUS_PAY_API_BASE_URL=
# Retour navigateur = page de suivi (SONDAGE) — jamais une preuve de paiement
GENIUS_PAY_RETURN_URL=https://<app-publique>/billing/return
GENIUS_PAY_CANCEL_URL=https://<app-publique>/billing/return
```

- `ALLOW_MOCK_PAYMENTS` doit rester **false** (le flux réel n'utilise jamais
  mock-confirm).
- Le boot **échoue volontairement** (fail-fast Zod) si `PAYMENT_PROVIDER=GENIUS_PAY`
  sans `GENIUS_PAY_API_KEY` / `GENIUS_PAY_SECRET_KEY` / `GENIUS_PAY_WEBHOOK_SECRET`.

## 2. Configuration du webhook dans le dashboard Genius Pay
1. Créer un webhook pointant sur : `https://<tunnel-public>/api/webhooks/payments/genius-pay`.
2. Abonner au moins l'événement `payment.success` (idéalement tous les `payment.*`).
3. Récupérer le **secret `whsec_…`** affiché → le placer dans
   `GENIUS_PAY_WEBHOOK_SECRET`. **Ne jamais l'afficher ni le committer.**
4. (Optionnel) Envoyer un `webhook.test` depuis le dashboard : l'API doit répondre
   **200** et créer une ligne `payment_webhook_events` en statut **IGNORED**
   (événement signé mais non actionnable).

## 3. Démarrage
1. `pnpm build --filter="./packages/*"` puis `pnpm db:migrate` (si nécessaire).
2. Lancer l'API et le worker (`pnpm dev` ou builds).
3. Ouvrir le tunnel : `ngrok http 4000` → reporter l'URL publique dans le webhook
   Genius Pay et dans `GENIUS_PAY_RETURN_URL` (app).
4. Vérifier la santé : `GET /api/health` → `ok`.

## 4. Parcours de test (sandbox d'abord)
1. Se connecter en tant qu'OWNER/ADMIN d'une organisation de test.
2. Aller sur **/billing** → le solde et le badge « Crédits insuffisants » (si 0).
3. Cliquer **« Acheter »** sur un pack → le backend appelle Genius Pay (create
   payment) et **redirige vers le checkout Mobile Money**.
4. **Payer** avec le numéro Mobile Money (validation USSD/OTP selon l'opérateur).
5. Au retour, la page **/billing/return** affiche « En attente de la confirmation… »
   puis, dès que le webhook a crédité, **« Paiement confirmé »** + les crédits.
6. Le solde de **/billing** se met à jour en temps réel (`wallet.balance.updated`).

## 5. Points de vérification (base + UI)
- `payment_webhook_events` : une ligne `RECEIVED → PROCESSED` (dédupliquée si
  Genius Pay rejoue). Aucune signature/secret dans `normalizedPayload`.
- `topups` : le TopUp passe **PAID** (`paidAt` renseigné).
- `wallet_transactions` : **une** ligne `CREDIT_PURCHASE` (jamais deux, même sur
  rejeu du webhook).
- `wallets` : `balanceCredits` augmenté de `creditsGranted + bonusCredits`.
- L'IA redevient éligible **automatiquement** : le prochain message client
  déclenche un run (aucun ancien message n'est rejoué).

## 6. Reconciliation (webhook perdu)
Si le webhook n'arrive pas (tunnel coupé, 5xx transitoire) : le TopUp reste
`PENDING`/`PROCESSING`. Le sweep de reconciliation (API) sonde
`getPaymentStatus` après `PAYMENT_RECONCILIATION_MIN_AGE_MS` et crédite via le
même `creditTopUp` (idempotent). Vérifier que le crédit finit par arriver sans
double crédit.

## 7. Cas d'incohérence (attendus)
- **Montant/devise du webhook ≠ TopUp figé** → TopUp **REVIEW_REQUIRED**, `failureCode`
  renseigné, **aucun crédit**. Aucun frontend ne peut forcer le crédit.
- **Signature invalide/absente** → **401**, aucune écriture. Le `returnUrl`
  navigateur ne prouve jamais un paiement.
- **`payment.failed/cancelled/expired`** → TopUp transite en FAILED/CANCELLED/EXPIRED,
  aucun crédit.

## 8. Sécurité — règles absolues
- Secrets Genius Pay **uniquement dans `.env`** (jamais `.env.example`, log,
  Swagger, DTO, frontend, test).
- Commencer par de **petits montants** en **sandbox**, puis un montant minimal en
  **live**.
- Ne jamais logger le corps brut du webhook avec sa signature.
- Passer en **live** seulement après un cycle sandbox complet réussi (create →
  paiement → webhook → crédit → reconciliation).

## 9. Dépannage
| Symptôme | Cause probable | Action |
|---|---|---|
| Boot échoue au démarrage | secret Genius Pay manquant | renseigner `API_KEY`/`SECRET_KEY`/`WEBHOOK_SECRET` dans `.env` |
| Webhook → 401 | mauvais `whsec_`, ou proxy qui altère le corps | vérifier le secret ; s'assurer que le corps brut n'est pas ré-encodé |
| TopUp jamais PAID | webhook non reçu (tunnel) | vérifier l'URL du webhook ; attendre la reconciliation |
| TopUp REVIEW_REQUIRED | montant/devise ≠ pack figé | vérifier la devise du pack et le montant envoyé |
| Solde non mis à jour dans l'UI | socket déconnecté | rafraîchir /billing (le solde vient de la base, le socket n'accélère que) |

---
**Rappel** : ce document décrit une procédure. Aucun paiement réel ne doit être
déclenché sans intention explicite, et aucun secret ne doit apparaître nulle part.
