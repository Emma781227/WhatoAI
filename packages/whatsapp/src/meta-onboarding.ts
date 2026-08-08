/**
 * Client d'ONBOARDING Meta (Embedded Signup) — package PUR, config INJECTÉE
 * (jamais de `process.env`). Distinct de `MetaCloudWhatsAppProvider` (messagerie) :
 * il fait les appels Graph de PROVISIONING (échange du code OAuth, abonnement de
 * l'App à la WABA, lecture du numéro). Le token obtenu est renvoyé à l'appelant
 * qui le CHIFFRE avant stockage — le client ne persiste ni ne logge jamais rien.
 * `graphBaseUrl` est surchargeable → les tests exercent le VRAI client contre un
 * faux serveur Graph, sans jamais appeler Meta.
 */

export interface MetaOnboardingConfig {
  appId?: string;
  appSecret?: string;
  graphApiVersion: string;
  graphBaseUrl: string;
  requestTimeoutMs?: number;
}

export interface ExchangedToken {
  accessToken: string;
  /** Durée de vie en secondes (null = longue durée / non fournie). L'appelant calcule expiresAt. */
  expiresInSeconds: number | null;
}

export interface OnboardedPhoneNumber {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
}

/** Erreur d'onboarding — jamais de secret ni de payload brut du gateway. */
export class MetaOnboardingError extends Error {
  public readonly code: string;
  constructor(message: string, code = 'META_ONBOARDING_ERROR') {
    super(message);
    this.code = code;
    this.name = 'MetaOnboardingError';
  }
}

export class MetaOnboardingClient {
  constructor(private readonly config: MetaOnboardingConfig) {}

  /** Échange le code Embedded Signup contre un token (client_id/secret en query, jamais loggés). */
  async exchangeCodeForToken(code: string): Promise<ExchangedToken> {
    if (!this.config.appId || !this.config.appSecret) {
      throw new MetaOnboardingError('Meta app credentials are not configured.', 'META_ONBOARDING_NOT_CONFIGURED');
    }
    const url =
      `${this.base()}/oauth/access_token` +
      `?client_id=${encodeURIComponent(this.config.appId)}` +
      `&client_secret=${encodeURIComponent(this.config.appSecret)}` +
      `&code=${encodeURIComponent(code)}`;
    const parsed = (await this.request('GET', url)) as { access_token?: string; expires_in?: number };
    if (!parsed?.access_token) {
      throw new MetaOnboardingError('Token exchange did not return an access token.', 'META_ONBOARDING_NO_TOKEN');
    }
    return {
      accessToken: parsed.access_token,
      expiresInSeconds: typeof parsed.expires_in === 'number' ? parsed.expires_in : null,
    };
  }

  /** Abonne l'App aux webhooks de la WABA du marchand (indispensable à la réception). */
  async subscribeApp(wabaId: string, accessToken: string): Promise<void> {
    const url = `${this.base()}/${encodeURIComponent(wabaId)}/subscribed_apps`;
    const parsed = (await this.request('POST', url, accessToken)) as { success?: boolean };
    if (parsed?.success !== true) {
      throw new MetaOnboardingError('App subscription to WABA failed.', 'META_ONBOARDING_SUBSCRIBE_FAILED');
    }
  }

  /** Lit les infos NON secrètes du numéro (affichage, nom vérifié, qualité). */
  async getPhoneNumber(phoneNumberId: string, accessToken: string): Promise<OnboardedPhoneNumber> {
    const url = `${this.base()}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`;
    const parsed = (await this.request('GET', url, accessToken)) as {
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
    };
    return {
      displayPhoneNumber: parsed.display_phone_number ?? null,
      verifiedName: parsed.verified_name ?? null,
      qualityRating: parsed.quality_rating ?? null,
    };
  }

  private base(): string {
    return `${this.config.graphBaseUrl}/${this.config.graphApiVersion}`;
  }

  private async request(method: 'GET' | 'POST', url: string, bearer?: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs ?? 30000);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      throw new MetaOnboardingError(
        isAbort ? 'Meta onboarding request timed out.' : 'Meta onboarding request failed (network).',
        isAbort ? 'META_ONBOARDING_TIMEOUT' : 'META_ONBOARDING_NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const code = (parsed as { error?: { code?: number } } | undefined)?.error?.code;
      throw new MetaOnboardingError(
        `Meta onboarding API error (HTTP ${response.status}).`,
        response.status === 401 || response.status === 403 || code === 190
          ? 'META_ONBOARDING_UNAUTHORIZED'
          : 'META_ONBOARDING_API_ERROR',
      );
    }
    return parsed;
  }
}
