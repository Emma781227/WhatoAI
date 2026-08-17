import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildMetaSignedRequest, parseMetaSignedRequest } from './meta-signed-request';

const SECRET = 'test-app-secret';

describe('parseMetaSignedRequest', () => {
  it('valide un signed_request correctement signé et renvoie le payload', () => {
    const signed = buildMetaSignedRequest({ user_id: 'FBUSER_1', issued_at: 1700000000 }, SECRET);
    const payload = parseMetaSignedRequest(signed, SECRET);
    expect(payload).toMatchObject({ algorithm: 'HMAC-SHA256', user_id: 'FBUSER_1' });
  });

  it('rejette une signature invalide (mauvais secret)', () => {
    const signed = buildMetaSignedRequest({ user_id: 'FBUSER_1' }, SECRET);
    expect(parseMetaSignedRequest(signed, 'wrong-secret')).toBeNull();
  });

  it('rejette un payload falsifié (signature ne correspond plus)', () => {
    const signed = buildMetaSignedRequest({ user_id: 'FBUSER_1' }, SECRET);
    const [sig] = signed.split('.');
    // Remplace le payload par un autre encodé, la signature d'origine ne colle plus.
    const forgedPayload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 'ATTACKER' }), 'utf8').toString('base64url');
    expect(parseMetaSignedRequest(`${sig}.${forgedPayload}`, SECRET)).toBeNull();
  });

  it('rejette un algorithme inattendu', () => {
    const encodedPayload = Buffer.from(JSON.stringify({ algorithm: 'PLAINTEXT', user_id: 'x' }), 'utf8').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(encodedPayload).digest('base64url');
    expect(parseMetaSignedRequest(`${sig}.${encodedPayload}`, SECRET)).toBeNull();
  });

  it('rejette les entrées malformées / absentes', () => {
    expect(parseMetaSignedRequest(undefined, SECRET)).toBeNull();
    expect(parseMetaSignedRequest('', SECRET)).toBeNull();
    expect(parseMetaSignedRequest('nodot', SECRET)).toBeNull();
    expect(parseMetaSignedRequest('a.b.c', SECRET)).toBeNull();
    expect(parseMetaSignedRequest(buildMetaSignedRequest({}, SECRET), undefined)).toBeNull();
  });
});
