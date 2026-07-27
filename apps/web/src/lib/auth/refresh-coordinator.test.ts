import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '@/features/auth/api';
import { clearAccessToken, getAccessToken } from '@/lib/api/token-store';

import {
  RefreshCoordinator,
  type AuthBroadcastMessage,
  type AuthChannel,
  type AuthSessionData,
} from './refresh-coordinator';

const USER: AuthUser = {
  id: 'user-1',
  email: 'a@b.cm',
  firstName: 'A',
  lastName: 'B',
  status: 'ACTIVE',
  emailVerifiedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
};

function session(token: string, expiresInMs = 15 * 60_000): AuthSessionData {
  return { accessToken: token, user: USER, expiresAt: Date.now() + expiresInMs };
}

/**
 * Bus inter-onglets simulé : chaque FakeChannel représente un onglet ;
 * postMessage livre aux AUTRES canaux du bus (comme BroadcastChannel).
 */
class FakeBroadcastBus {
  private channels: FakeChannel[] = [];
  connect(): FakeChannel {
    const channel = new FakeChannel(this);
    this.channels.push(channel);
    return channel;
  }
  deliver(from: FakeChannel, message: AuthBroadcastMessage): void {
    for (const channel of this.channels) {
      if (channel !== from) {
        channel.receive(message);
      }
    }
  }
}

class FakeChannel implements AuthChannel {
  private listeners: Array<(event: { data: AuthBroadcastMessage }) => void> = [];
  constructor(private readonly bus: FakeBroadcastBus) {}
  postMessage(message: AuthBroadcastMessage): void {
    this.bus.deliver(this, message);
  }
  addEventListener(_type: 'message', listener: (event: { data: AuthBroadcastMessage }) => void): void {
    this.listeners.push(listener);
  }
  receive(message: AuthBroadcastMessage): void {
    this.listeners.forEach((listener) => listener({ data: message }));
  }
  close(): void {
    this.listeners = [];
  }
}

/** Verrou exclusif partagé simulant navigator.locks entre "onglets". */
class FakeLockManager {
  private tail: Promise<unknown> = Promise.resolve();
  acquire = <T>(_name: string, callback: () => Promise<T>): Promise<T> => {
    const next = this.tail.then(callback, callback);
    this.tail = next.catch(() => undefined);
    return next;
  };
}

afterEach(() => {
  clearAccessToken();
});

describe('RefreshCoordinator', () => {
  it('single-flight local : N appels concurrents → UN seul appel réseau', async () => {
    const refreshFn = vi.fn(async () => session('token-1'));
    const coordinator = new RefreshCoordinator({ refreshFn, channelFactory: () => null });

    const results = await Promise.all([
      coordinator.refresh(),
      coordinator.refresh(),
      coordinator.refresh(),
    ]);

    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result?.accessToken === 'token-1')).toBe(true);
    expect(getAccessToken()).toBe('token-1');
  });

  it('deux "onglets" simultanés : un seul /auth/refresh, l’autre adopte le token diffusé', async () => {
    const bus = new FakeBroadcastBus();
    const locks = new FakeLockManager();
    const refreshA = vi.fn(async () => session('token-from-A'));
    const refreshB = vi.fn(async () => session('token-from-B'));

    const tabA = new RefreshCoordinator({
      refreshFn: refreshA,
      channelFactory: () => bus.connect(),
      acquireLock: locks.acquire,
    });
    const tabB = new RefreshCoordinator({
      refreshFn: refreshB,
      channelFactory: () => bus.connect(),
      acquireLock: locks.acquire,
    });

    const [resultA, resultB] = await Promise.all([tabA.refresh(), tabB.refresh()]);

    // Un seul des deux onglets a appelé le réseau ; l'autre a réutilisé le
    // token diffusé (frais) sans rappeler /auth/refresh.
    expect(refreshA.mock.calls.length + refreshB.mock.calls.length).toBe(1);
    expect(resultA?.accessToken).toBe('token-from-A');
    expect(resultB?.accessToken).toBe('token-from-A');
  });

  it('AUTH_TOKEN_UPDATED d’un autre onglet met à jour le token en mémoire et notifie', () => {
    const bus = new FakeBroadcastBus();
    const tabA = new RefreshCoordinator({
      refreshFn: async () => null,
      channelFactory: () => bus.connect(),
      acquireLock: async (_name, callback) => callback(),
    });
    const tabB = new RefreshCoordinator({
      refreshFn: async () => null,
      channelFactory: () => bus.connect(),
      acquireLock: async (_name, callback) => callback(),
    });

    const received = vi.fn();
    tabB.onSession(received);

    tabA.applyLocalSession(session('broadcast-token'));

    expect(getAccessToken()).toBe('broadcast-token');
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'broadcast-token' }),
    );
  });

  it('logout diffusé : tous les onglets purgent le token et notifient', () => {
    const bus = new FakeBroadcastBus();
    const tabA = new RefreshCoordinator({
      refreshFn: async () => null,
      channelFactory: () => bus.connect(),
      acquireLock: async (_name, callback) => callback(),
    });
    const tabB = new RefreshCoordinator({
      refreshFn: async () => null,
      channelFactory: () => bus.connect(),
      acquireLock: async (_name, callback) => callback(),
    });

    tabA.applyLocalSession(session('to-be-cleared'));
    const loggedOut = vi.fn();
    tabB.onLogout(loggedOut);

    tabA.broadcastLogout();

    expect(getAccessToken()).toBeNull();
    expect(loggedOut).toHaveBeenCalledTimes(1);
  });

  it('fallback sans BroadcastChannel ni locks : le refresh fonctionne en solo', async () => {
    const refreshFn = vi.fn(async () => session('solo-token'));
    const coordinator = new RefreshCoordinator({ refreshFn, channelFactory: () => null });

    const result = await coordinator.refresh();
    expect(result?.accessToken).toBe('solo-token');
  });

  it('refresh refusé (session morte) → null, token non modifié', async () => {
    const coordinator = new RefreshCoordinator({
      refreshFn: async () => null,
      channelFactory: () => null,
    });
    await expect(coordinator.refresh()).resolves.toBeNull();
    expect(getAccessToken()).toBeNull();
  });
});
