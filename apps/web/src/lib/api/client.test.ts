import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api-error';
import { apiRequest, setUnauthorizedHandler } from './client';
import { clearAccessToken, setAccessToken } from './token-store';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  setUnauthorizedHandler(null);
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiRequest', () => {
  it('utilise NEXT_PUBLIC_API_URL tel quel — /api présent UNE seule fois', async () => {
    fetchMock.mockResolvedValue(ok({ status: 'ok' }));
    await apiRequest('/health');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('http://localhost:4000/api/health');
    expect(url.match(/\/api/g)).toHaveLength(1);
  });

  it('envoie credentials include et le Bearer quand un token existe', async () => {
    setAccessToken('my-access-token');
    fetchMock.mockResolvedValue(ok({}));
    await apiRequest('/auth/me');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer my-access-token');
  });

  it('sans token : aucun header Authorization', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await apiRequest('/health');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('sérialise le body en JSON avec Content-Type', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await apiRequest('/auth/login', { method: 'POST', body: { email: 'a@b.c' } });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ email: 'a@b.c' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('204 → undefined', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiRequest('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('erreur HTTP → ApiError normalisée', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 404, code: 'SHOP_NOT_FOUND', message: 'Shop not found.' }), {
        status: 404,
      }),
    );
    const error = await apiRequest('/x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('SHOP_NOT_FOUND');
  });

  it('panne réseau → ApiError NETWORK_ERROR (jamais une TypeError brute)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const error = await apiRequest('/x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('NETWORK_ERROR');
  });

  it('401 → handler de refresh puis UN seul replay', async () => {
    const handler = vi.fn(async () => {
      setAccessToken('refreshed-token');
      return true;
    });
    setUnauthorizedHandler(handler);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ statusCode: 401 }), { status: 401 }))
      .mockResolvedValueOnce(ok({ id: 'user-1' }));

    const result = await apiRequest<{ id: string }>('/auth/me');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const replayInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((replayInit.headers as Record<string, string>).Authorization).toBe('Bearer refreshed-token');
    expect(result.id).toBe('user-1');
  });

  it('401 avec refresh impossible → ApiError 401, pas de replay', async () => {
    setUnauthorizedHandler(vi.fn(async () => false));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ statusCode: 401 }), { status: 401 }));

    const error = await apiRequest('/auth/me').catch((caught: unknown) => caught);
    expect((error as ApiError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skipAuthRetry : jamais de refresh (routes auth elles-mêmes)', async () => {
    const handler = vi.fn(async () => true);
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ statusCode: 401 }), { status: 401 }));

    await apiRequest('/auth/login', { method: 'POST', body: {}, skipAuthRetry: true }).catch(() => null);
    expect(handler).not.toHaveBeenCalled();
  });

  it('transmet AbortSignal et laisse remonter AbortError', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });
    controller.abort();

    const error = await apiRequest('/x', { signal: controller.signal }).catch((caught: unknown) => caught);
    expect((error as DOMException).name).toBe('AbortError');
  });
});
