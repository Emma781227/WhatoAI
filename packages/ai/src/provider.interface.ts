import type {
  AiConfigurationCheck,
  AiContinueInput,
  AiGenerateInput,
  AiProviderName,
  AiProviderResponse,
  AiSummarizeInput,
} from './types';

/**
 * Contrat provider IA — volontairement SANS ÉTAT (D6 validée) : le worker
 * pilote la boucle d'outils, borne le nombre de tours et exécute les outils
 * métier tenant-scopés. Le provider ne fait qu'un aller-retour avec le modèle.
 *
 * Le contrat ne dépend d'aucun type du SDK Google : `GeminiAiProvider` traduit
 * entre ces types internes et l'API du fournisseur.
 */
export interface AiProvider {
  getProviderName(): AiProviderName;

  /** Premier tour : prompt système + contexte + outils déclarés. */
  generateSuggestion(input: AiGenerateInput): Promise<AiProviderResponse>;

  /** Tour suivant : mêmes entrées + résultats des outils exécutés par le worker. */
  continueWithToolResults(input: AiContinueInput): Promise<AiProviderResponse>;

  /**
   * Résumé roulant d'une conversation (CI-G2). Appel SÉPARÉ et facturé : aucun
   * outil n'est exposé et aucune sortie structurée n'est imposée — le résumé
   * est du texte, il ne décide de rien. Son usage (tokens) remonte dans
   * `AiProviderResponse.usage`, donc dans la consommation du run porteur.
   */
  summarizeConversation(input: AiSummarizeInput): Promise<AiProviderResponse>;

  /**
   * Vérification de configuration — appel de LECTURE uniquement, jamais une
   * génération facturée non sollicitée (même posture que le health Meta, qui
   * n'envoie aucun message).
   */
  validateConfiguration(): Promise<AiConfigurationCheck>;
}
