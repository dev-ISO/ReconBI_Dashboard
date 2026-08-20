// @vitest-environment jsdom
/**
 * ShareDialog smoke coverage. The dialog had NO tests when its people picker
 * was extracted into the shared UserPicker (0.14.1) — 184 lines moved out of a
 * permission surface with nothing pinning it. These tests exist so that
 * refactor, and the next one, cannot silently break granting.
 *
 * Pinned here: existing grants render; a picked directory user reaches the
 * PUT payload with the template's permissions; and a directory OUTAGE degrades
 * to an inline note instead of blanking the dialog — that last one is a
 * deliberate behavior change from the extraction (previously one failed
 * Promise.all replaced the whole dialog with an error, taking the grants list
 * with it, so someone opening the dialog to REVOKE access was blocked by an
 * unrelated search failure).
 *
 * Plus (0.14.1 owner batch, A1) the two ids the SERVER refuses as grant
 * targets — the caller and the owner — never being offered, and never being
 * sent even if one is somehow staged: ValidateGrantTargets runs before any
 * write, so one bad target used to 400 the ENTIRE save and lose every other
 * person picked alongside it.
 */
import { act, type ReactNode } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RcdFetcher, RcdRequestInit } from '@recon/dashboards-core';
import { DashboardsProvider } from '../src/provider/DashboardsProvider';
import { ShareDialog } from '../src/dashboard/ShareDialog';

const DIRECTORY = [
  { id: 'u7', displayName: 'brianna', email: 'brianna@example.com' },
  { id: 'u9', displayName: 'carlos', email: 'carlos@example.com' },
];

/** One existing grant, so the "revoke path stays usable" assertions have a target. */
const EXISTING_SHARES = [
  {
    userId: 'u1',
    displayName: 'ann',
    canEditLayout: false,
    canManagePages: false,
    canEditCharts: false,
    canMoveTiles: false,
    canDeleteContent: false,
    grantedByDisplayName: 'owner',
    grantedUtc: '2026-08-01T00:00:00Z',
  },
];

interface RecordedCall {
  path: string;
  init?: RcdRequestInit;
}

const makeFetcher = (options: { directoryFails?: boolean; selfUserId?: string } = {}) => {
  const calls: RecordedCall[] = [];
  const fetcher = (<T,>(path: string, init?: RcdRequestInit): Promise<T> => {
    calls.push({ path, init });
    if (path.includes('/users')) {
      return options.directoryFails
        ? Promise.reject(new Error('directory down'))
        : (Promise.resolve(DIRECTORY as T));
    }
    if (path.includes('/shares')) {
      // The PUT resolves with nothing; the GET returns the grant set.
      return Promise.resolve(
        (init?.method === 'PUT' ? {} : { shares: EXISTING_SHARES }) as T,
      );
    }
    if (path === '/api/rcd/v1/meta') {
      // userId is how the frontend learns who it is (the store never does).
      // Absent = older server = the pre-0.14.1 behavior.
      return Promise.resolve({
        canManageShared: false,
        ...(options.selfUserId !== undefined ? { userId: options.selfUserId } : null),
      } as T);
    }
    if (path === '/api/rcd/v1/dashboards') return Promise.resolve([] as T);
    return Promise.resolve([] as T);
  }) as RcdFetcher;
  return { calls, fetcher };
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = async (fetcher: RcdFetcher, children: ReactNode) => {
  await act(async () => {
    root.render(
      <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={fetcher}>
        {children}
      </DashboardsProvider>,
    );
  });
};

const buttonByText = (text: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  );
  if (!button) throw new Error(`No button containing "${text}"`);
  return button as HTMLButtonElement;
};

const hasButton = (text: string): boolean =>
  [...document.querySelectorAll('button')].some((b) => b.textContent?.includes(text));

const click = async (button: HTMLButtonElement) => {
  await act(async () => {
    button.click();
  });
};

describe('ShareDialog', () => {
  it('renders the existing grants', async () => {
    const { fetcher } = makeFetcher();
    await mount(fetcher, <ShareDialog open dashboardId={7} onClose={() => {}} />);

    expect(document.body.textContent).toContain('ann');
  });

  it('sends a picked directory user in the PUT payload with the template permissions', async () => {
    const { calls, fetcher } = makeFetcher();
    await mount(fetcher, <ShareDialog open dashboardId={7} onClose={() => {}} />);

    await click(buttonByText('brianna'));
    // The chip is staged; Save must include it even without pressing "Add".
    await click(buttonByText('Save'));

    const put = calls.find((call) => call.init?.method === 'PUT' && call.path.includes('/shares'));
    expect(put).toBeDefined();
    // The fetcher contract passes `body` as the object itself — the HOST fetcher
    // serializes it, so there is nothing to JSON.parse here.
    const body = put?.init?.body as unknown as {
      shares: { userId: string; canEditLayout: boolean }[];
    };
    expect(body.shares.map((share) => share.userId)).toContain('u7');
    // Default template is view-only: every right false.
    expect(body.shares.find((share) => share.userId === 'u7')?.canEditLayout).toBe(false);
    // The pre-existing grant is preserved — the PUT replaces the whole set.
    expect(body.shares.map((share) => share.userId)).toContain('u1');
  });

  it('never offers the signed-in user (the server refuses a self-share)', async () => {
    const { fetcher } = makeFetcher({ selfUserId: 'u9' });
    await mount(fetcher, <ShareDialog open dashboardId={7} onClose={() => {}} />);

    expect(hasButton('carlos')).toBe(false);
    // Everyone else is still offered — this is an exclusion, not an outage.
    expect(hasButton('brianna')).toBe(true);
  });

  it('never offers the dashboard owner (an admin editing someone else’s shares)', async () => {
    const { fetcher } = makeFetcher({ selfUserId: 'u9' });
    await mount(
      fetcher,
      <ShareDialog open dashboardId={7} onClose={() => {}} ownerUserId="u7" />,
    );

    expect(hasButton('brianna')).toBe(false);
    expect(hasButton('carlos')).toBe(false);
  });

  it('still offers everyone when the server sends no userId (older server)', async () => {
    const { fetcher } = makeFetcher();
    await mount(fetcher, <ShareDialog open dashboardId={7} onClose={() => {}} />);

    expect(hasButton('brianna')).toBe(true);
    expect(hasButton('carlos')).toBe(true);
  });

  it('drops a forbidden target from the PUT instead of losing the whole save', async () => {
    // 'u1' is an existing grant row AND the caller: the server would reject the
    // whole PUT over it, taking the newly picked person with it.
    const { calls, fetcher } = makeFetcher({ selfUserId: 'u1' });
    await mount(fetcher, <ShareDialog open dashboardId={7} onClose={() => {}} />);

    await click(buttonByText('brianna'));
    await click(buttonByText('Save'));

    const put = calls.find((call) => call.init?.method === 'PUT' && call.path.includes('/shares'));
    const body = put?.init?.body as unknown as { shares: { userId: string }[] };
    expect(body.shares.map((share) => share.userId)).toEqual(['u7']);
  });

  it('keeps the grants list usable when the user directory fails', async () => {
    const { fetcher } = makeFetcher({ directoryFails: true });
    await mount(fetcher, <ShareDialog open dashboardId={7} onClose={() => {}} />);

    // The dialog is NOT replaced by an error: the existing grant still renders
    // and can still be revoked.
    expect(document.body.textContent).toContain('ann');
    expect(buttonByText('Save')).toBeTruthy();
  });
});
