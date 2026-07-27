const SLUG_MAX_LENGTH = 50;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Diacritiques combinants produits par la décomposition NFD (U+0300–U+036F).
const COMBINING_DIACRITICS = /[̀-ͯ]/g;

/**
 * Normalise un nom en slug : minuscules, accents supprimés (NFD), tout
 * caractère non alphanumérique remplacé par un tiret, tirets consécutifs
 * fusionnés, tirets de bord supprimés, longueur bornée.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
}

export function isValidSlug(slug: string): boolean {
  return slug.length >= 2 && slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
}

/** Variante suffixée pour résoudre les collisions du slug auto-généré. */
export function suffixedSlug(base: string, attempt: number): string {
  const suffix = `-${attempt}`;
  return base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, '') + suffix;
}
