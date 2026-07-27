import { buildCombinationKey } from '@whauto/shared';

export interface OptionDraft {
  name: string;
  values: string[];
}

export interface VariantCombination {
  /** Clé CANONIQUE (mêmes règles que le backend) — identité stable de la combinaison. */
  key: string;
  /** Sélections dans l'ordre des options fournies. */
  selections: Array<{ optionName: string; value: string }>;
  /** Libellé "M / Rouge". */
  label: string;
}

/**
 * Produit cartésien des options — ORDRE DÉTERMINISTE (ordre des options puis
 * des valeurs telles que saisies), zéro doublon (les doublons de valeurs sont
 * ignorés, insensible à la casse). Fonction PURE, testée.
 *
 * La clé canonique permet de PRÉSERVER les saisies existantes quand une
 * option change : une combinaison qui existe encore garde la même clé, donc
 * les données déjà saisies (SKU, prix, stock) lui restent associées.
 */
export function generateVariantCombinations(options: OptionDraft[]): VariantCombination[] {
  const cleaned = options
    .map((option) => ({
      name: option.name.trim(),
      values: option.values
        .map((value) => value.trim())
        .filter(
          (value, index, all) =>
            value !== '' &&
            all.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index,
        ),
    }))
    .filter((option) => option.name !== '' && option.values.length > 0);

  if (cleaned.length === 0) {
    return [];
  }

  let combinations: Array<Array<{ optionName: string; value: string }>> = [[]];
  for (const option of cleaned) {
    combinations = combinations.flatMap((combination) =>
      option.values.map((value) => [...combination, { optionName: option.name, value }]),
    );
  }

  return combinations.map((selections) => ({
    key: buildCombinationKey(selections),
    selections,
    label: selections.map((selection) => selection.value).join(' / '),
  }));
}

/**
 * Réconcilie les brouillons de variantes avec de nouvelles combinaisons :
 * les données saisies survivent tant que la combinaison existe (par clé) ;
 * les combinaisons disparues sont retournées à part — l'appelant AVERTIT
 * avant toute suppression (jamais d'archive implicite, décision validée).
 */
export function reconcileVariantDrafts<TDraft extends { combinationKey: string }>(
  drafts: TDraft[],
  combinations: VariantCombination[],
): { kept: TDraft[]; added: VariantCombination[]; removed: TDraft[] } {
  const draftKeys = new Set(drafts.map((draft) => draft.combinationKey));
  const combinationKeys = new Set(combinations.map((combination) => combination.key));
  return {
    kept: drafts.filter((draft) => combinationKeys.has(draft.combinationKey)),
    added: combinations.filter((combination) => !draftKeys.has(combination.key)),
    removed: drafts.filter((draft) => !combinationKeys.has(draft.combinationKey)),
  };
}
