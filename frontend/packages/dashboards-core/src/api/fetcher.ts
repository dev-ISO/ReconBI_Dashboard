// Host-agnostic transport seam. Hosts adapt their own authenticated request
// wrapper to this shape in a few lines; the portal passes a plain fetch
// wrapper. The library never touches tokens or storage.

export interface RcdRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Resolve with the RAW 2xx Response (T = Response) instead of parsed JSON —
   * used for non-JSON payloads (CSV export downloads). Error handling is
   * unchanged: non-2xx still throws RcdApiError. Host-adapted fetchers that
   * pre-date this flag simply need to return the Response untouched when set.
   */
  raw?: boolean;
}

export type RcdFetcher = <T>(path: string, init?: RcdRequestInit) => Promise<T>;

/** Normalized API failure surfaced to UI states. */
export class RcdApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorCode: string | null = null,
    public readonly issues: { code: string; severity: string; message: string; path: string | null }[] = [],
  ) {
    super(message);
    this.name = 'RcdApiError';
  }
}

/** Default fetcher for standalone use (portal/demo). */
export const createFetchFetcher =
  (getToken?: () => string | null): RcdFetcher =>
  async <T>(path: string, init?: RcdRequestInit): Promise<T> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init?.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(path, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init?.signal ?? null,
    });

    if (!response.ok) {
      let errorCode: string | null = null;
      let detail = `${response.status} ${response.statusText}`;
      let issues: RcdApiError['issues'] = [];
      try {
        const problem = (await response.json()) as {
          detail?: string;
          errorCode?: string;
          issues?: RcdApiError['issues'];
        };
        errorCode = problem.errorCode ?? null;
        detail = problem.detail ?? detail;
        issues = problem.issues ?? [];
      } catch {
        // non-JSON error body: keep the status text
      }
      throw new RcdApiError(detail, response.status, errorCode, issues);
    }

    if (init?.raw) return response as unknown as T;
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
