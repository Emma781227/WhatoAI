# Whauto AI — Feuille de route vers le 100 % opérationnel

## Où on en est (déjà construit ✅)
Le **cœur du commerce conversationnel** est livré et testé :
- Auth, Organisations + rôles (RBAC), Boutiques.
- WhatsApp conversationnel (inbox, contacts, conversations, temps réel) — provider Mock **et** Meta Cloud.
- Catalogue (produits, variantes, stock), Panier/Checkout, Commandes.
- **Agent IA** : suggestions (SUGGEST_ONLY) **et** réponse automatique (AUTO_REPLY) avec garde-fous, escalade, mémoire de conversation.

**Limite actuelle** : intégration Meta en **pilote unique** (une boutique de test, secrets dans `.env`). Pas encore d'auto-inscription, pas de facturation/crédits, pas de synchro catalogue WhatsApp. L'IA marche mais bute sur le **quota gratuit Gemini (20 req/jour)** → nécessite la facturation Google.

---

## Ce qui reste, par objectif

### A. Onboarding « numéro → tout connecté » (Meta Embedded Signup)
> *Un utilisateur arrive, met son numéro WhatsApp Business, et est directement branché.*

1. **Embedded Signup** : intégrer le flux *Facebook Login for Business + WhatsApp* (l'utilisateur autorise sa WABA en quelques clics).
2. **Tokens multi-tenants chiffrés** : activer les colonnes `*Encrypted` du canal + un **module de chiffrement au repos** (aujourd'hui les secrets Meta ne vivent que dans `.env`, mono-boutique). Chaque boutique aura son propre token.
3. **Enregistrement automatique** du numéro + abonnement webhook par WABA (le routage par `phone_number_id` existe déjà).
4. **UI d'onboarding guidée** (assistant pas-à-pas).
5. ⚠️ **Dépendance externe Meta (longue)** : *App Review* + *Business Verification* obligatoires pour ouvrir au public (permissions `whatsapp_business_messaging`, `business_management`, `catalog_management`). Compter plusieurs semaines côté Meta.

### B. Modèle économique — Crédits / Portefeuille + Paiement SaaS
> *Acheter du crédit (monnaie virtuelle) pour activer l'agent IA.*

1. **Module Billing/Wallet** : solde de crédits par organisation + grand livre (ledger) immuable des mouvements.
2. **Recharge** : paiement **Mobile Money** (MTN MoMo, Orange Money — cible Cameroun/XAF) et/ou **carte (Stripe)**. Packs de crédits.
3. **Comptage (metering)** : déduire des crédits **à chaque réponse IA** (le modèle `AiRun` trace déjà tokens/latence → base parfaite). Définir l'unité (par réponse, ou par tokens).
4. **Coupe-circuit** : crédits épuisés → IA désactivée automatiquement (repli suggestion/humain), notification de recharge.
5. **Tableau de bord** consommation + historique + achat de crédits.

### C. IA conversationnelle en production
> *L'IA converse normalement avec le client.*

1. **Activer la facturation Gemini** (Google AI Studio / Google Cloud → *Billing*) : enlève la limite 20/jour → limites élevées. **C'est le seul vrai blocage actuel de l'IA** (le moteur est déjà construit).
2. **Brancher la consommation IA sur les crédits** (module B) — c'est ainsi que votre modèle économique se matérialise.
3. (Optionnel) Réglages fins de style par boutique (déjà possible via `systemPromptOverride`).

### D. Synchronisation du catalogue WhatsApp (bidirectionnelle)
> *Boutique/produit créé sur le SaaS → apparaît dans le WhatsApp Business, et inversement.*

1. **SaaS → Meta (sortant)** : créer/mettre à jour le **catalogue Meta Commerce** (Commerce/Catalog API) à chaque création de boutique/produit. Nécessite `catalog_management` + WABA liée à un catalogue Meta.
2. **Meta → SaaS (entrant)** : récupérer les produits ajoutés/modifiés côté **mobile** (app WhatsApp Business).
   - ⚠️ Meta ne pousse pas de webhook fiable pour chaque édition marchande → il faudra probablement un **sync périodique (polling delta)** du catalogue, en plus du webhook `catalog` quand disponible.
3. **Moteur de synchronisation** : table de correspondance produit SaaS ↔ item Meta, détection de delta, **gestion des conflits** (qui gagne si les deux changent), idempotence.
   - C'est la brique **la plus complexe** (sync bidirectionnelle réelle).

### E. Durcissement « production » (transverse)
1. **Chiffrement des secrets au repos** (prérequis de A — tokens Meta multi-tenants).
2. **Templates WhatsApp** : messages hors fenêtre 24 h (relances, notifications) — soumis à validation Meta.
3. **Paiement CLIENT des commandes** (Mobile Money/carte) — l'acheteur paie le marchand. **Distinct** des crédits SaaS (le statut paiement existe déjà côté Order, sans intégration réelle).
4. **Déploiement** : hébergement `app.` / `api.` (même domaine enregistrable — contrainte cookie), HTTPS, base gérée + backups, Redis persistant, files BullMQ, workers scalables.
5. **Observabilité** : logs structurés (déjà en place), suivi d'erreurs (Sentry), métriques, alertes.
6. **Conformité** : WhatsApp Business Policy, RGPD/《protection des données》, CGU/CGV, mentions légales.

---

## Priorités & ce qu'on peut faire **en attendant le reset du quota Gemini**

Tout ci-dessous **ne consomme PAS** de quota Gemini — on peut avancer immédiatement :

| Priorité | Chantier | Pourquoi maintenant |
|---|---|---|
| 🔴 **1** | **Activer la facturation Gemini** (5 min, côté Google) | Débloque l'IA réelle tout de suite, coût quasi nul en test |
| 🔴 **2** | **Module Crédits/Wallet + metering** (B) | Votre modèle économique ; testable en MOCK, sans Gemini |
| 🟠 **3** | **Paiement Mobile Money** (recharge crédits) | Nécessaire à B ; intégration MTN/Orange |
| 🟠 **4** | **Chiffrement des secrets + tokens multi-tenants** (A.2/E.1) | Prérequis de l'auto-inscription |
| 🟡 **5** | **Meta Embedded Signup** (A) + lancer **App Review** en parallèle | Le long pole Meta — démarrer tôt |
| 🟡 **6** | **Catalog sync SaaS → Meta** (D.1), puis bidirectionnel (D.2/3) | Valeur produit forte ; commencer par le sens sortant |
| 🟢 **7** | Templates, paiement client, déploiement, conformité (E) | Avant l'ouverture publique |

**En résumé** : le produit conversationnel + IA est **fait**. Ce qui reste pour votre vision = **(A) auto-inscription Meta**, **(B) crédits/paiement = votre business model**, **(D) synchro catalogue**, et **(E) mise en production**. Les gros délais viennent de **Meta (App Review, Embedded Signup, Catalog)**, pas du code.
