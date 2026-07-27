import { CUSTOMER_SERVICE_WINDOW_MS } from './whatsapp-constants';

/**
 * Calcul de la fenêtre de service client (24 h), basé sur le timestamp du
 * message entrant FOURNI PAR LE PROVIDER (pas l'heure de traitement — un
 * webhook retardé ne doit pas prolonger artificiellement la fenêtre).
 *
 * Règles :
 * - expiration candidate = providerTimestamp + 24 h ;
 * - un timestamp dans le futur (horloge fournisseur aberrante) est borné à
 *   `now` — jamais de fenêtre > 24 h ;
 * - on conserve max(expiration courante, candidate) : un événement ancien
 *   (relivraison, replay) ne RÉDUIT jamais une fenêtre déjà ouverte.
 */
export function computeCustomerServiceWindowExpiry(input: {
  providerTimestamp: Date;
  now: Date;
  currentExpiresAt: Date | null;
}): Date {
  const { providerTimestamp, now, currentExpiresAt } = input;

  const boundedTimestamp = providerTimestamp.getTime() > now.getTime() ? now : providerTimestamp;
  const candidate = new Date(boundedTimestamp.getTime() + CUSTOMER_SERVICE_WINDOW_MS);

  if (currentExpiresAt !== null && currentExpiresAt.getTime() > candidate.getTime()) {
    return currentExpiresAt;
  }
  return candidate;
}

export function isCustomerServiceWindowOpen(
  expiresAt: Date | null,
  now: Date,
): boolean {
  return expiresAt !== null && expiresAt.getTime() > now.getTime();
}
