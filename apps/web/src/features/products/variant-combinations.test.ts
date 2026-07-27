import { describe, expect, it } from 'vitest';

import {
  generateVariantCombinations,
  reconcileVariantDrafts,
} from './variant-combinations';

describe('generateVariantCombinations', () => {
  it('génère le produit cartésien dans un ordre déterministe', () => {
    const combinations = generateVariantCombinations([
      { name: 'Taille', values: ['S', 'M'] },
      { name: 'Couleur', values: ['Rouge', 'Bleu'] },
    ]);
    expect(combinations.map((combination) => combination.label)).toEqual([
      'S / Rouge',
      'S / Bleu',
      'M / Rouge',
      'M / Bleu',
    ]);
  });

  it('aucune combinaison en doublon (valeurs dupliquées ignorées, insensible à la casse)', () => {
    const combinations = generateVariantCombinations([
      { name: 'Taille', values: ['M', 'm', ' M '] },
    ]);
    expect(combinations).toHaveLength(1);
  });

  it('ignore les options vides et retourne [] sans options exploitables', () => {
    expect(generateVariantCombinations([])).toEqual([]);
    expect(generateVariantCombinations([{ name: '', values: ['x'] }])).toEqual([]);
    expect(generateVariantCombinations([{ name: 'Taille', values: ['', '  '] }])).toEqual([]);
  });

  it('la clé est canonique : indépendante de l’ordre des options', () => {
    const a = generateVariantCombinations([
      { name: 'Taille', values: ['M'] },
      { name: 'Couleur', values: ['Rouge'] },
    ])[0];
    const b = generateVariantCombinations([
      { name: 'Couleur', values: ['Rouge'] },
      { name: 'Taille', values: ['M'] },
    ])[0];
    expect(a.key).toBe(b.key);
  });
});

describe('reconcileVariantDrafts — préservation des saisies', () => {
  const drafts = [
    { combinationKey: '[["couleur","rouge"],["taille","m"]]', sku: 'TEE-M-R' },
    { combinationKey: '[["couleur","bleu"],["taille","m"]]', sku: 'TEE-M-B' },
  ];

  it('conserve les brouillons dont la combinaison existe encore', () => {
    const combinations = generateVariantCombinations([
      { name: 'Taille', values: ['M'] },
      { name: 'Couleur', values: ['Rouge', 'Bleu', 'Vert'] },
    ]);
    const { kept, added, removed } = reconcileVariantDrafts(drafts, combinations);
    expect(kept).toHaveLength(2); // saisies préservées
    expect(added).toHaveLength(1); // Vert / M
    expect(removed).toHaveLength(0);
  });

  it('signale les brouillons disparus (jamais de suppression silencieuse)', () => {
    const combinations = generateVariantCombinations([
      { name: 'Taille', values: ['M'] },
      { name: 'Couleur', values: ['Rouge'] },
    ]);
    const { kept, removed } = reconcileVariantDrafts(drafts, combinations);
    expect(kept.map((draft) => draft.sku)).toEqual(['TEE-M-R']);
    expect(removed.map((draft) => draft.sku)).toEqual(['TEE-M-B']);
  });
});
