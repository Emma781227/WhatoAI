import { isValidSlug, slugify, suffixedSlug } from './slug.util';

describe('slug.util', () => {
  describe('slugify', () => {
    it('normalise minuscules, accents et espaces', () => {
      expect(slugify('Boutique Aïcha')).toBe('boutique-aicha');
      expect(slugify('Épicerie du Marché')).toBe('epicerie-du-marche');
    });

    it('fusionne les séparateurs consécutifs et supprime les tirets de bord', () => {
      expect(slugify('  --Ma   Boutique!!  ')).toBe('ma-boutique');
      expect(slugify('a__b..c')).toBe('a-b-c');
    });

    it('borne la longueur à 50 caractères sans tiret final', () => {
      const slug = slugify('a'.repeat(45) + ' bcdefgh');
      expect(slug.length).toBeLessThanOrEqual(50);
      expect(slug.endsWith('-')).toBe(false);
    });

    it('retourne une chaîne vide pour un nom sans caractère translittérable', () => {
      expect(slugify('!!! ???')).toBe('');
    });
  });

  describe('isValidSlug', () => {
    it('accepte les slugs conformes', () => {
      expect(isValidSlug('boutique-aicha')).toBe(true);
      expect(isValidSlug('a1')).toBe(true);
    });

    it('rejette majuscules, tirets doubles, bords et longueurs invalides', () => {
      expect(isValidSlug('Boutique')).toBe(false);
      expect(isValidSlug('a--b')).toBe(false);
      expect(isValidSlug('-ab')).toBe(false);
      expect(isValidSlug('ab-')).toBe(false);
      expect(isValidSlug('a')).toBe(false);
      expect(isValidSlug('a'.repeat(51))).toBe(false);
    });
  });

  describe('suffixedSlug', () => {
    it('ajoute le suffixe en respectant la longueur maximale', () => {
      expect(suffixedSlug('boutique', 2)).toBe('boutique-2');
      const long = suffixedSlug('a'.repeat(50), 12);
      expect(long.length).toBeLessThanOrEqual(50);
      expect(long.endsWith('-12')).toBe(true);
      expect(isValidSlug(long)).toBe(true);
    });
  });
});
