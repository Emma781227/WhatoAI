import type { AuthUser } from '@/features/auth/api';
import { getAccessToken, getTokenExpiry, setAccessToken } from '@/lib/api/token-store';

export interface AuthSessionData {
  accessToken: string;
  user: AuthUser;
  /** ms epoch, décodé du claim exp — uniquement pour la planification. */
  expiresAt: number | null;
}

export type AuthBroadcastMessage =
  | { type: 'AUTH_TOKEN_UPDATED'; accessToken: string; user: AuthUser; expiresAt: number | null }
  | { type: 'AUTH_LOGGED_OUT' };

/** Sous-ensemble de BroadcastChannel injectable dans les tests. */
export interface AuthChannel {
  postMessage(message: AuthBroadcastMessage): void;
  addEventListener(type: 'message', listener: (event: { data: AuthBroadcastMessage }) => void): void;
  close(): void;
}

export interface RefreshCoordinatorOptions {
  /** POST /auth/refresh — retourne null si le backend refuse (session morte). */
  refreshFn: () => Promise<AuthSessionData | null>;
  /**
   * Fabrique du canal inter-onglets. Fallback documenté : si BroadcastChannel
   * n'existe pas (très vieux navigateurs), chaque onglet vit seul — le verrou
   * Web Locks continue de sérialiser les refresh concurrents, et sans lui le
   * single-flight local reste la dernière ligne de défense.
   */
  channelFactory?: () => AuthChannel | null;
  /**
   * Verrou exclusif inter-onglets. Fallback documenté : sans navigator.locks,
   * exécution directe — le single-flight par onglet reste garanti.
   */
  acquireLock?: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

const CHANNEL_NAME = 'whauto-auth';
const LOCK_NAME = 'whauto-auth-refresh';
/** Marge sous laquelle un token est considéré comme à renouveler. */
const FRESHNESS_MARGIN_MS = 60_000;

function defaultChannelFactory(): AuthChannel | null {
  if (typeof BroadcastChannel === 'undefined') {
    return null;
  }
  return new BroadcastChannel(CHANNEL_NAME) as unknown as AuthChannel;
}

async function defaultAcquireLock<T>(name: string, callback: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    return navigator.locks.request(name, callback) as Promise<T>;
  }
  return callback();
}

/**
 * Coordination du refresh token entre requêtes ET entre onglets.
 *
 * - single-flight local : une seule promesse de refresh par onglet ;
 * - verrou Web Locks "whauto-auth-refresh" : un seul onglet appelle
 *   /auth/refresh à la fois (indispensable : la rotation du refresh token
 *   fait échouer tout appel concurrent, et une réutilisation détectée
 *   révoquerait la famille de sessions) ;
 * - BroadcastChannel "whauto-auth" : l'onglet gagnant diffuse le nouveau
 *   token EN MÉMOIRE (AUTH_TOKEN_UPDATED) — jamais via localStorage — et les
 *   autres onglets l'adoptent sans rappeler /auth/refresh ;
 * - logout : AUTH_LOGGED_OUT déconnecte tous les onglets.
 */
export class RefreshCoordinator {
  private readonly refreshFn: RefreshCoordinatorOptions['refreshFn'];
  private readonly acquireLock: NonNullable<RefreshCoordinatorOptions['acquireLock']>;
  private readonly now: () => number;
  private readonly channel: AuthChannel | null;

  private inflight: Promise<AuthSessionData | null> | null = null;
  private lastKnownExpiry: number | null = null;
  private lastKnownUser: AuthUser | null = null;

  private sessionListeners = new Set<(session: AuthSessionData) => void>();
  private logoutListeners = new Set<() => void>();

  constructor(options: RefreshCoordinatorOptions) {
    this.refreshFn = options.refreshFn;
    this.acquireLock = options.acquireLock ?? defaultAcquireLock;
    this.now = options.now ?? Date.now;
    this.channel = (options.channelFactory ?? defaultChannelFactory)();

    this.channel?.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'AUTH_TOKEN_UPDATED') {
        // Un autre onglet a rafraîchi : on adopte son token sans appel réseau.
        setAccessToken(message.accessToken);
        this.lastKnownExpiry = message.expiresAt;
        this.lastKnownUser = message.user;
        const session: AuthSessionData = {
          accessToken: message.accessToken,
          user: message.user,
          expiresAt: message.expiresAt,
        };
        this.sessionListeners.forEach((listener) => listener(session));
      } else if (message.type === 'AUTH_LOGGED_OUT') {
        setAccessToken(null);
        this.lastKnownExpiry = null;
        this.lastKnownUser = null;
        this.logoutListeners.forEach((listener) => listener());
      }
    });
  }

  onSession(listener: (session: AuthSessionData) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  onLogout(listener: () => void): () => void {
    this.logoutListeners.add(listener);
    return () => this.logoutListeners.delete(listener);
  }

  /** Après login/register/change-password : enregistre et diffuse la session locale. */
  applyLocalSession(session: AuthSessionData): void {
    setAccessToken(session.accessToken);
    this.lastKnownExpiry = session.expiresAt;
    this.lastKnownUser = session.user;
    this.channel?.postMessage({
      type: 'AUTH_TOKEN_UPDATED',
      accessToken: session.accessToken,
      user: session.user,
      expiresAt: session.expiresAt,
    });
  }

  /** Après logout local : purge et déconnecte les autres onglets. */
  broadcastLogout(): void {
    setAccessToken(null);
    this.lastKnownExpiry = null;
    this.lastKnownUser = null;
    this.channel?.postMessage({ type: 'AUTH_LOGGED_OUT' });
  }

  /**
   * Rafraîchit la session (ou réutilise un token encore frais obtenu par un
   * autre onglet pendant l'attente du verrou). Retourne null si la session
   * est réellement morte.
   */
  refresh(): Promise<AuthSessionData | null> {
    this.inflight ??= this.acquireLock(LOCK_NAME, async () => {
      // Pendant l'attente du verrou, un autre onglet a pu diffuser un token
      // frais : dans ce cas, aucun appel /auth/refresh supplémentaire.
      const current = getAccessToken();
      if (
        current !== null &&
        this.lastKnownUser !== null &&
        this.lastKnownExpiry !== null &&
        this.lastKnownExpiry - this.now() > FRESHNESS_MARGIN_MS
      ) {
        return {
          accessToken: current,
          user: this.lastKnownUser,
          expiresAt: this.lastKnownExpiry,
        };
      }

      const session = await this.refreshFn();
      if (session) {
        this.applyLocalSession(session);
      }
      return session;
    }).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  dispose(): void {
    this.channel?.close();
    this.sessionListeners.clear();
    this.logoutListeners.clear();
  }
}

export function sessionFromResponse(response: {
  accessToken: string;
  user: AuthUser;
}): AuthSessionData {
  return {
    accessToken: response.accessToken,
    user: response.user,
    expiresAt: getTokenExpiry(response.accessToken),
  };
}
