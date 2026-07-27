import { describe, expect, it } from 'vitest';

import { ApiError, apiErrorFromResponse, getErrorMessage, NETWORK_ERROR_CODE } from './api-error';

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('apiErrorFromResponse', () => {
  it('mappe le corps DomainErrorFilter du backend { statusCode, code, message }', async () => {
    const error = await apiErrorFromResponse(
      jsonResponse(409, { statusCode: 409, code: 'EMAIL_ALREADY_USED', message: 'Already used.' }),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe('EMAIL_ALREADY_USED');
    expect(error.message).toBe('Already used.');
  });

  it('gère les messages tableau (ValidationPipe NestJS)', async () => {
    const error = await apiErrorFromResponse(
      jsonResponse(400, { statusCode: 400, message: ['name too short', 'slug invalid'] }),
    );
    expect(error.message).toBe('name too short slug invalid');
    expect(error.code).toBe('UNKNOWN_ERROR');
  });

  it('survit à un corps non-JSON', async () => {
    const error = await apiErrorFromResponse(new Response('boom', { status: 502 }));
    expect(error.status).toBe(502);
    expect(error.code).toBe('UNKNOWN_ERROR');
  });

  it('récupère requestId du corps ou du header x-request-id', async () => {
    const fromBody = await apiErrorFromResponse(
      jsonResponse(500, { statusCode: 500, message: 'oops', requestId: 'req-1' }),
    );
    expect(fromBody.requestId).toBe('req-1');

    const fromHeader = await apiErrorFromResponse(
      jsonResponse(500, { statusCode: 500, message: 'oops' }, { 'x-request-id': 'req-2' }),
    );
    expect(fromHeader.requestId).toBe('req-2');
  });
});

describe('getErrorMessage', () => {
  it('affiche tel quel un message métier 4xx (contrôlé par le backend)', () => {
    const error = new ApiError({ status: 403, code: 'SHOP_ARCHIVED', message: 'This shop is archived.' });
    expect(getErrorMessage(error)).toBe('This shop is archived.');
  });

  it('ne divulgue JAMAIS un message technique 500 — message public + requestId', () => {
    const error = new ApiError({
      status: 500,
      code: 'UNKNOWN_ERROR',
      message: 'PrismaClientKnownRequestError: connect ECONNREFUSED 127.0.0.1:5433',
      requestId: 'req-42',
    });
    const message = getErrorMessage(error);
    expect(message).not.toContain('Prisma');
    expect(message).not.toContain('ECONNREFUSED');
    expect(message).toContain('réf. req-42');
  });

  it('message réseau dédié', () => {
    const error = new ApiError({ status: 0, code: NETWORK_ERROR_CODE, message: 'fetch failed' });
    expect(getErrorMessage(error)).toContain('connexion');
  });

  it('erreur inconnue → message public générique', () => {
    expect(getErrorMessage(new Error('stack trace interne'))).not.toContain('stack');
  });
});
