/**
 * Sécurise le paramètre `next` des redirections post-login : seuls les
 * chemins INTERNES sont acceptés (un seul "/" initial). Les URLs absolues,
 * protocoles (`https:`, `javascript:`…) et chemins "//" (protocol-relative)
 * sont refusés — protection contre l'open redirect.
 */
export function getSafeInternalPath(value: string | null | undefined, fallback = '/dashboard'): string {
  if (!value) {
    return fallback;
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return fallback;
  }
  return value;
}
