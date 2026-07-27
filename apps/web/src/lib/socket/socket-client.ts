import { io, type Socket } from 'socket.io-client';

import { getAccessToken } from '@/lib/api/token-store';
import { env } from '@/lib/env';

/**
 * Singleton Socket.IO. Règles :
 * - le token part dans handshake.auth (JAMAIS dans l'URL) via une fonction :
 *   chaque (re)connexion lit le token COURANT du token-store — la reconnexion
 *   après un refresh utilise donc automatiquement le nouveau token ;
 * - le serveur déconnecte à l'expiration du JWT. ⚠️ PIÈGE RÉEL (vérifié dans
 *   socket.io@4.8.3) : `socket.disconnect(true)` côté serveur envoie D'ABORD un
 *   paquet DISCONNECT, que le client traite en `destroy()` + reason
 *   "io server disconnect" — `socket.active` passe false et la reconnexion
 *   automatique N'A PAS LIEU. Le temps réel mourait donc silencieusement au
 *   bout d'un access token (15 min) jusqu'au rechargement de la page. D'où
 *   `reconnectWithFreshToken` (proactif, au refresh) et la reconnexion
 *   manuelle du provider (filet de sécurité) ;
 * - les événements sockets ne sont JAMAIS la source de vérité : les abonnés
 *   à onReconnected refetchent depuis l'API (réconciliation PostgreSQL).
 */

/** Seule raison de déconnexion dont le client ne se relève pas tout seul. */
export const SERVER_INITIATED_DISCONNECT = 'io server disconnect';

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 10_000;

let socket: Socket | null = null;

/**
 * Faut-il reconnecter à la main ? Uniquement après une coupure serveur ET
 * avec un token en mémoire : sans token la session est réellement finie et
 * réessayer ne ferait que marteler l'API avec des handshakes refusés.
 */
export function shouldManuallyReconnect(reason: string, hasToken: boolean): boolean {
  return reason === SERVER_INITIATED_DISCONNECT && hasToken;
}

/** Backoff exponentiel borné — jamais de boucle serrée sur un token invalide. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
}

function apiOrigin(): string {
  // NEXT_PUBLIC_API_URL contient le préfixe /api — Socket.IO vit à la racine.
  const url = new URL(env.NEXT_PUBLIC_API_URL);
  return url.origin;
}

export function getSocket(): Socket {
  if (socket) {
    return socket;
  }
  socket = io(apiOrigin(), {
    // Fonction évaluée à CHAQUE tentative de connexion : token toujours frais.
    auth: (cb) => cb({ token: getAccessToken() ?? '' }),
    withCredentials: true,
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });
  return socket;
}

export function connectSocket(): Socket {
  const instance = getSocket();
  if (!instance.connected) {
    instance.connect();
  }
  return instance;
}

export function disconnectSocket(): void {
  socket?.disconnect();
}

/**
 * Rejoue le handshake avec le token courant (appelé après un refresh préventif,
 * ~60 s avant l'expiration) : le serveur repart sur un nouveau minuteur et sa
 * déconnexion à expiration n'a jamais lieu. No-op si aucun socket n'est
 * connecté — rien à renouveler.
 */
export function reconnectWithFreshToken(): void {
  if (!socket?.connected) {
    return;
  }
  socket.disconnect();
  socket.connect();
}

/** Réinitialisation complète (logout) : détruit l'instance et ses listeners. */
export function destroySocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
