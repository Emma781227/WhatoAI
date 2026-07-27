import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeSocket = {
  connected: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
  removeAllListeners: vi.fn(),
};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => fakeSocket),
}));

import {
  destroySocket,
  getSocket,
  reconnectDelayMs,
  reconnectWithFreshToken,
  SERVER_INITIATED_DISCONNECT,
  shouldManuallyReconnect,
} from './socket-client';

beforeEach(() => {
  destroySocket();
  fakeSocket.connected = false;
  fakeSocket.connect.mockClear();
  fakeSocket.disconnect.mockClear();
  fakeSocket.removeAllListeners.mockClear();
});

describe('shouldManuallyReconnect', () => {
  it('coupure serveur avec token : reconnexion manuelle nécessaire', () => {
    // socket.io ne se relève JAMAIS seul de "io server disconnect" —
    // c'est le cas de l'expiration du JWT côté gateway.
    expect(shouldManuallyReconnect(SERVER_INITIATED_DISCONNECT, true)).toBe(true);
  });

  it('coupure serveur SANS token : on n’insiste pas (session finie)', () => {
    expect(shouldManuallyReconnect(SERVER_INITIATED_DISCONNECT, false)).toBe(false);
  });

  it.each(['transport close', 'ping timeout', 'io client disconnect'])(
    'raison "%s" : socket.io gère lui-même, aucune reconnexion manuelle',
    (reason) => {
      expect(shouldManuallyReconnect(reason, true)).toBe(false);
    },
  );
});

describe('reconnectDelayMs', () => {
  it('backoff exponentiel depuis 1 s', () => {
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(1)).toBe(2_000);
    expect(reconnectDelayMs(2)).toBe(4_000);
  });

  it('borné à 10 s — jamais de boucle serrée contre l’API', () => {
    expect(reconnectDelayMs(10)).toBe(10_000);
    expect(reconnectDelayMs(50)).toBe(10_000);
  });
});

describe('reconnectWithFreshToken', () => {
  it('socket connecté : rejoue le handshake (disconnect puis connect)', () => {
    getSocket();
    fakeSocket.connected = true;

    reconnectWithFreshToken();

    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(fakeSocket.connect).toHaveBeenCalledTimes(1);
  });

  it('socket non connecté : no-op (rien à renouveler)', () => {
    getSocket();
    fakeSocket.connected = false;

    reconnectWithFreshToken();

    expect(fakeSocket.disconnect).not.toHaveBeenCalled();
    expect(fakeSocket.connect).not.toHaveBeenCalled();
  });

  it('aucun socket créé : no-op sans lever', () => {
    expect(() => reconnectWithFreshToken()).not.toThrow();
    expect(fakeSocket.connect).not.toHaveBeenCalled();
  });
});
