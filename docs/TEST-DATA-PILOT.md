# Données de test — Shop pilote (NE PAS confondre avec la production)

> ⚠️ **Toutes les entités listées ici appartiennent à la Shop pilote de test.**
> Elles ont été créées manuellement pour valider les tests réels end-to-end
> (Meta Cloud + Gemini SUGGEST_ONLY). **Ce ne sont PAS des données de production.**
> Conservées volontairement (décision du 2026-07-27) — ne pas purger sans validation explicite.

## Shop pilote

| Champ | Valeur |
|---|---|
| Shop id | `cmrmb3rv9000gdqwogwipxsyk` |
| Nom / slug | `biz-manager` |
| Statut | `DRAFT` |
| Organisation | `biz-manager` |
| Canal WhatsApp | META_CLOUD, lié au `META_PHONE_NUMBER_ID` de test (numéro Meta « Test Number ») |

Toute donnée dont la chaîne de rattachement remonte à ce `shopId` est de la donnée de test.

## Inventaire des entités de test rattachées (au 2026-07-27)

| Entité | Nombre | Notes |
|---|---|---|
| `contacts` | 1 | numéro WhatsApp de test autorisé (`+33760271735`) |
| `conversations` | 1 | conversation du test réel |
| `messages` | 27 | inbound client + réponses (dont l'envoi IA livré/lu) |
| `ai_runs` | 6 | générations Gemini (essais de modèle + run final SUCCEEDED) |
| `ai_suggestions` | 1 | suggestion acceptée (`cms2cibiy000bdqo0etqzyfhs`), envoyée et lue |
| `ai_tool_calls` | 6 | appels d'outils lecture seule (`search_products`, `get_product_details`…) |
| `conversation_handoffs` | 2 | **CANCELLED** — vestiges des essais de modèle sur-transféreur (avant bascule vers `gemini-3.5-flash`) ; aucun handoff ouvert |
| `products` | 1 | « Sac Cabas Test » + variante + inventaire (15 000 XAF) |
| `whatsapp_channels` | 1 | canal Meta de test |

## Test réel validé (sous-phase B)

- **Modèle** : `gemini-3.5-flash`, prompt `v1`, 2 tours d'outils, ~4 400 tokens.
- **Flux** : message client WhatsApp → suggestion IA (prix/stock issus des outils) → validation
  humaine → envoi via le flux Messages existant → **SENT → DELIVERED → READ** sur le vrai téléphone.
- **Garanties vérifiées** : 0 envoi automatique, 0 handoff ouvert simultané à une suggestion,
  0 fuite de `thoughtSignature` (DB/logs/DTO/socket/audit), aucun secret exposé.

## Comment ré-identifier / isoler ces données

```sql
-- Tout ce qui appartient à la Shop pilote de test :
--   filtrer sur shopId = 'cmrmb3rv9000gdqwogwipxsyk'
-- Exemple : messages de test
SELECT m.*
FROM messages m
JOIN conversations c ON c.id = m."conversationId"
WHERE c."shopId" = 'cmrmb3rv9000gdqwogwipxsyk';
```

Pour un futur nettoyage (uniquement sur décision explicite), supprimer en remontant les
dépendances FK : `ai_tool_calls` → `ai_suggestions` → `ai_runs`, `conversation_handoffs`,
`messages` → `conversations` → `contacts`, puis `products`/inventaire et `whatsapp_channels`,
en restant borné à ce `shopId`.
