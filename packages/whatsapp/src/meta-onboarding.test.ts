import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MetaOnboardingClient, MetaOnboardingError } from './meta-onboarding';

/**
 * Le VRAI MetaOnboardingClient exercé contre un FAUX serveur Graph reproduisant
 * les endpoints d'onboarding (oauth/access_token, subscribed_apps, phone number).
 * Aucun appel vers Meta. On vérifie les requêtes émises (query/headers) et le
 * mapping d'erreurs, sans jamais fuiter de secret.
 */

let server: Server;
let baseUrl: string;
let last: { method?: string; url?: string; auth?: string } | null = null;
let handler: (req: { method?: string; url?: string }) => { status: number; body: unknown };

function client(overrides: Partial<ConstructorParameters<typeof MetaOnboardingClient>[0]> = {}) {
  return new MetaOnboardingClient({
    appId: 'APP-ID',
    appSecret: 'APP-SECRET',
    graphApiVersion: 'v21.0',
    graphBaseUrl: baseUrl,
    requestTimeoutMs: 1000,
    ...overrides,
  });
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      last = { method: req.method, url: req.url, auth: req.headers.authorization as string | undefined };
      const result = handler({ method: req.method, url: req.url });
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('MetaOnboardingClient', () => {
  it('exchangeCodeForToken : envoie client_id/secret + code, renvoie token + durée', async () => {
    handler = () => ({ status: 200, body: { access_token: 'EAAG-onboard-token', token_type: 'bearer', expires_in: 5183944 } });
    const result = await client().exchangeCodeForToken('CODE-123');
    expect(result).toEqual({ accessToken: 'EAAG-onboard-token', expiresInSeconds: 5183944 });
    expect(last?.url).toContain('/oauth/access_token');
    expect(last?.url).toContain('client_id=APP-ID');
    expect(last?.url).toContain('code=CODE-123');
  });

  it('exchange sans access_token → META_ONBOARDING_NO_TOKEN', async () => {
    handler = () => ({ status: 200, body: { token_type: 'bearer' } });
    await expect(client().exchangeCodeForToken('c')).rejects.toMatchObject({ code: 'META_ONBOARDING_NO_TOKEN' });
  });

  it('subscribeApp : POST subscribed_apps avec Bearer, succès', async () => {
    handler = () => ({ status: 200, body: { success: true } });
    await client().subscribeApp('WABA-1', 'TOK');
    expect(last?.method).toBe('POST');
    expect(last?.url).toContain('/WABA-1/subscribed_apps');
    expect(last?.auth).toBe('Bearer TOK');
  });

  it('subscribeApp sans success:true → META_ONBOARDING_SUBSCRIBE_FAILED', async () => {
    handler = () => ({ status: 200, body: { success: false } });
    await expect(client().subscribeApp('WABA-1', 'TOK')).rejects.toMatchObject({ code: 'META_ONBOARDING_SUBSCRIBE_FAILED' });
  });

  it('getPhoneNumber : lit display/verified/quality', async () => {
    handler = () => ({ status: 200, body: { display_phone_number: '+237 6 00 00 00 00', verified_name: 'Ma Boutique', quality_rating: 'GREEN' } });
    const info = await client().getPhoneNumber('PHONE-1', 'TOK');
    expect(info).toEqual({ displayPhoneNumber: '+237 6 00 00 00 00', verifiedName: 'Ma Boutique', qualityRating: 'GREEN' });
    expect(last?.url).toContain('/PHONE-1?fields=display_phone_number');
  });

  it('401 / token invalide → META_ONBOARDING_UNAUTHORIZED', async () => {
    handler = () => ({ status: 401, body: { error: { code: 190, message: 'x' } } });
    await expect(client().getPhoneNumber('PHONE-1', 'BAD')).rejects.toMatchObject({ code: 'META_ONBOARDING_UNAUTHORIZED' });
  });

  it('app non configurée → META_ONBOARDING_NOT_CONFIGURED (aucun appel réseau)', async () => {
    await expect(client({ appId: undefined }).exchangeCodeForToken('c')).rejects.toMatchObject({ code: 'META_ONBOARDING_NOT_CONFIGURED' });
  });

  it('les erreurs ne contiennent jamais le secret d’App', async () => {
    handler = () => ({ status: 500, body: { error: { message: 'boom' } } });
    try {
      await client().exchangeCodeForToken('c');
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MetaOnboardingError);
      expect(`${(e as Error).message} ${JSON.stringify(e)}`).not.toContain('APP-SECRET');
    }
  });
});
