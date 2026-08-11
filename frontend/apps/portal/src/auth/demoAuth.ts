import { useSyncExternalStore } from 'react';
import { createFetchFetcher, RcdApiError, type RcdFetcher } from '@recon/dashboards-core';

// Demo-host authentication: pick a canned user, hold the JWT in localStorage.
// This whole module is portal-only; hosts wire their own auth into RcdFetcher.

export interface DemoUser {
  username: string;
  displayName: string;
  role: string;
}

export const DEMO_USERS: DemoUser[] = [
  { username: 'carol', displayName: 'Carol (admin)', role: 'Admin' },
  { username: 'alice', displayName: 'Alice (author, Gulf Coast)', role: 'Author' },
  { username: 'bob', displayName: 'Bob (viewer)', role: 'Member' },
];

const TOKEN_KEY = 'rcd-portal-token';
const USER_KEY = 'rcd-portal-user';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const getUsername = (): string | null => localStorage.getItem(USER_KEY);

export async function loginAs(username: string): Promise<void> {
  const response = await fetch('/api/demo-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!response.ok) throw new Error(`Demo login failed (${response.status})`);
  const body = (await response.json()) as { token: string; username: string };
  localStorage.setItem(TOKEN_KEY, body.token);
  localStorage.setItem(USER_KEY, body.username);
  notify();
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  notify();
}

export function useCurrentUser(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getUsername,
    () => null,
  );
}

/**
 * Silent re-login on token expiry. Demo tokens are passwordless (the demo
 * host mints one for any canned user), so an expired JWT is never a dead
 * end: mint a fresh token for the remembered user and retry once. Concurrent
 * 401s share one in-flight re-login.
 */
let relogging: Promise<void> | null = null;
const reloginAsStoredUser = (): Promise<void> => {
  const username = getUsername();
  if (!username) return Promise.reject(new Error('No demo user selected.'));
  relogging ??= loginAs(username).finally(() => {
    relogging = null;
  });
  return relogging;
};

const baseFetcher = createFetchFetcher(getToken);

/** Fetcher handed to DashboardsProvider — attaches the demo JWT and
 *  transparently refreshes it when the server says 401. */
export const portalFetcher: RcdFetcher = async <T,>(
  path: string,
  init?: Parameters<RcdFetcher>[1],
): Promise<T> => {
  try {
    return await baseFetcher<T>(path, init);
  } catch (error) {
    if (error instanceof RcdApiError && error.status === 401 && getUsername() !== null) {
      await reloginAsStoredUser();
      return baseFetcher<T>(path, init);
    }
    throw error;
  }
};
