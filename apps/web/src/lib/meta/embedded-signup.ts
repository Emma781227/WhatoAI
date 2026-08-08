import { env } from '@/lib/env';

/**
 * Intégration RÉELLE du SDK JS Meta pour l'Embedded Signup WhatsApp.
 *
 * Ce module isole toute l'interaction avec le SDK externe `window.FB` :
 * - le chargement du script `connect.facebook.net` (une seule fois) ;
 * - l'écoute du `message` postMessage émis par la popup Embedded Signup
 *   (waba_id / phone_number_id / business_id) ;
 * - le `FB.login(config_id, response_type: 'code')` qui renvoie le `code` OAuth.
 *
 * Le composant importe `launchEmbeddedSignup` et le mocke en test : aucune
 * logique métier ne dépend directement du SDK. Le SECRET d'App n'intervient
 * JAMAIS ici — le `code` est échangé côté serveur uniquement.
 */

export interface EmbeddedSignupResult {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  businessId: string;
}

export class EmbeddedSignupError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_CONFIGURED'
      | 'SDK_LOAD_FAILED'
      | 'CANCELLED'
      | 'INCOMPLETE_SESSION',
  ) {
    super(message);
    this.name = 'EmbeddedSignupError';
  }
}

interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}

interface FbSdk {
  init(options: Record<string, unknown>): void;
  login(
    callback: (response: FbLoginResponse) => void,
    options: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';
const GRAPH_VERSION = 'v21.0';

let sdkPromise: Promise<FbSdk> | null = null;

/** Charge et initialise le SDK Meta une seule fois (idempotent). */
function loadSdk(appId: string): Promise<FbSdk> {
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<FbSdk>((resolve, reject) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      reject(new EmbeddedSignupError('SDK indisponible hors navigateur.', 'SDK_LOAD_FAILED'));
      return;
    }
    if (window.FB) {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION });
      resolve(window.FB);
      return;
    }

    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION });
      if (window.FB) resolve(window.FB);
      else reject(new EmbeddedSignupError('SDK Meta introuvable après init.', 'SDK_LOAD_FAILED'));
    };

    const script = document.createElement('script');
    script.src = SDK_SRC;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      sdkPromise = null;
      reject(new EmbeddedSignupError('Échec du chargement du SDK Meta.', 'SDK_LOAD_FAILED'));
    };
    document.body.appendChild(script);
  });

  return sdkPromise;
}

interface EmbeddedSignupSessionData {
  waba_id?: string;
  phone_number_id?: string;
  business_id?: string;
}

/**
 * Lance l'Embedded Signup et résout avec { code, wabaId, phoneNumberId, businessId }.
 * Le `code` vient de FB.login ; les identifiants WABA/numéro/business viennent du
 * message posté par la popup Meta. Les deux doivent aboutir pour réussir.
 */
export async function launchEmbeddedSignup(): Promise<EmbeddedSignupResult> {
  const appId = env.NEXT_PUBLIC_META_APP_ID;
  const configId = env.NEXT_PUBLIC_META_CONFIG_ID;
  if (!appId || !configId) {
    throw new EmbeddedSignupError('Embedded Signup Meta non configuré.', 'NOT_CONFIGURED');
  }

  const fb = await loadSdk(appId);

  // Holder object : évite que l'analyse de flux TS réduise la variable à `null`
  // (l'assignation se fait dans la closure `onMessage`).
  const holder: { session: EmbeddedSignupSessionData | null } = { session: null };
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') {
      return;
    }
    try {
      const parsed = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (parsed?.type === 'WA_EMBEDDED_SIGNUP' && parsed?.event === 'FINISH') {
        holder.session = parsed.data as EmbeddedSignupSessionData;
      }
    } catch {
      // Message non-JSON étranger au flux : ignoré.
    }
  };
  window.addEventListener('message', onMessage);

  try {
    const code = await new Promise<string>((resolve, reject) => {
      fb.login(
        (response) => {
          const c = response.authResponse?.code;
          if (c) resolve(c);
          else reject(new EmbeddedSignupError('Connexion Meta annulée.', 'CANCELLED'));
        },
        {
          config_id: configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
        },
      );
    });

    const session = holder.session;
    if (!session?.waba_id || !session.phone_number_id || !session.business_id) {
      throw new EmbeddedSignupError(
        'Session Embedded Signup incomplète (identifiants manquants).',
        'INCOMPLETE_SESSION',
      );
    }

    return {
      code,
      wabaId: session.waba_id,
      phoneNumberId: session.phone_number_id,
      businessId: session.business_id,
    };
  } finally {
    window.removeEventListener('message', onMessage);
  }
}
