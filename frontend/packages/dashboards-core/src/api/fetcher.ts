// Host-agnostic transport seam. Hosts adapt their own authenticated request
// wrapper to this shape in a few lines; the portal passes a plain fetch
// wrapper. The library never touches tokens or storage.

export interface RcdRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Resolve with the RAW 2xx Response (T = Response) instead of parsed JSON —
   * used for non-JSON payloads (CSV export downloads). Error handling is
   * unchanged: non-2xx still throws RcdApiError. Host-adapted fetchers that
   * pre-date this flag simply need to return the Response untouched when set.
   */
  raw?: boolean;
  /**
   * Forward as fetch's keepalive so the request survives page teardown — the
   * pagehide op-buffer flush rides this. BEST EFFORT: host-adapted fetchers
   * that pre-date the flag ignore it and the flush degrades to a normal send.
   */
  keepalive?: boolean;
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

/**
 * Fallback texts for well-known error codes whose response carried no usable
 * detail (a bare "403 Forbidden" status line). Server-provided detail always
 * wins — the backend's messages are contract-specified and more precise.
 */
const FRIENDLY_ERROR_TEXT: Record<string, string> = {
  'rcd.dashboard.permission_denied': 'Your access to this dashboard does not allow that change.',
  'rcd.dashboard.system_readonly':
    'This is a built-in dashboard managed by the application. Make a copy to edit it.',
  'rcd.model.system_readonly':
    'This is a built-in model managed by the application. Make a copy to edit it.',
  'rcd.dashboard.share_forbidden_fields':
    'Your access does not allow changing the name, description, linked model, or publish state.',
  'rcd.dashboard.share_target_invalid': 'One of the selected users cannot be granted access.',
  'rcd.dashboard.stale':
    'This dashboard changed on the server since you opened it. Reload to get the latest version.',
};

/**
 * Human message for any error: RcdApiError detail (or, when the detail is just
 * the raw status line, the error code's canned text) plus any error-severity
 * validation issues; Error.message / String(error) otherwise.
 */
export const rcdErrorMessage = (error: unknown): string => {
  if (error instanceof RcdApiError) {
    const statusLineOnly = /^\d{3}\s/.test(error.message);
    const friendly = error.errorCode === null ? undefined : FRIENDLY_ERROR_TEXT[error.errorCode];
    const base = statusLineOnly && friendly ? friendly : error.message;
    const issueText = error.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message)
      .join(' ');
    return issueText ? `${base} ${issueText}` : base;
  }
  return error instanceof Error ? error.message : String(error);
};

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
      ...(init?.keepalive ? { keepalive: true } : {}),
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
