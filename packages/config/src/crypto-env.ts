import { z } from 'zod';

/**
 * Chiffrement des secrets au repos (tokens Meta multi-tenant, futurs credentials
 * providers). Partagé API + worker. La clé maître ne vit QUE dans l'environnement
 * (jamais en base, log, Swagger, test réel ou frontend).
 *
 * - `SECRETS_ENCRYPTION_KEY` : clé ACTIVE (32 octets encodés en base64) ;
 * - `SECRETS_ENCRYPTION_KEYS_PREVIOUS` : JSON d'un tableau de clés base64
 *   précédentes, pour DÉCHIFFRER pendant une rotation.
 *
 * OPTIONNELLES à ce stade (fondation) : sans clé, le `SecretsEncryptionService`
 * lève une erreur explicite s'il est sollicité. Le fail-fast (clé requise)
 * viendra avec le stockage réel des tokens Meta (groupe suivant).
 */
export const cryptoEnvFields = {
  SECRETS_ENCRYPTION_KEY: z.string().optional(),
  SECRETS_ENCRYPTION_KEYS_PREVIOUS: z.string().optional(),
} as const;
