import type {
  AiConfigurationCheck,
  AiContinueInput,
  AiGenerateInput,
  AiProviderName,
  AiProviderResponse,
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
   * Vérification de configuration — appel de LECTURE uniquement, jamais une
   * génération facturée non sollicitée (même posture que le health Meta, qui
   * n'envoie aucun message).
   */
  validateConfiguration(): Promise<AiConfigurationCheck>;
}
