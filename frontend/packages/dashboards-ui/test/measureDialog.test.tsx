// @vitest-environment jsdom
/**
 * THE FLAW, END TO END — the measure dialog itself, which had no test at all.
 *
 * The unit test next door pins the path filter; this one proves the DIALOG
 * behaves: with somebody else's calculated measure broken in the same model,
 * Save stays enabled for the measure you are actually editing, and it disables
 * the moment the server blames YOUR row.
 *
 * Also pinned here: the duplicate-name rejection the owner asked for. It is a
 * CLIENT rule on purpose — the server's own duplicate-name check (MDL010) is a
 * path-less warning, and it cannot see dashboard or personal measures at all,
 * because they are not in the stored model.
 */
import { act, type ReactNode } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Measure,
  ModelDefinition,
  RcdFetcher,
  RcdRequestInit,
} from '@recon/dashboards-core';
import { DashboardsProvider } from '../src/provider/DashboardsProvider';
import { MeasureDialog } from '../src/model-editor/MeasureDialog';

const measure = (id: string, name: string, expression?: string): Measure => ({
  id,
  name,
  table: 'public.orders',
  aggregation: 'sum',
  ...(expression ? { expression } : { column: 'total' }),
});

/** measures[0] is a BROKEN formula belonging to somebody else. */
const BROKEN = measure('m-broken', 'Broken', 'SUM(public.orders.nope)');
const MINE = measure('m-mine', 'Mine', 'SUM(public.orders.total) * 2');

const DEFINITION: ModelDefinition = {
  version: 1,
  tables: [{ schema: 'public', name: 'orders' }],
  relationships: [],
  measures: [BROKEN, MINE],
};

type ValidationIssueWire = {
  code: string;
  severity: string;
  message: string;
  path: string | null;
};

/** Answers /models/validate with a fixed issue list. */
const makeFetcher = (issues: ValidationIssueWire[]) => {
  const calls: { path: string; init?: RcdRequestInit }[] = [];
  const fetcher = (<T,>(path: string, init?: RcdRequestInit): Promise<T> => {
    calls.push({ path, init });
    if (path.endsWith('/models/validate')) {
      return Promise.resolve({ valid: issues.length === 0, issues } as T);
    }
    if (path.endsWith('/meta')) return Promise.resolve({ canManageShared: false } as T);
    return Promise.resolve({} as T);
  }) as RcdFetcher;
  return { calls, fetcher };
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const mount = (fetcher: RcdFetcher, children: ReactNode) => {
  act(() => {
    root.render(
      <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={fetcher}>
        {children}
      </DashboardsProvider>,
    );
  });
};

/** React-compatible typing: set the value through the native setter, then fire. */
const typeInto = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const prototype =
    element instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

const buttonByText = (text: string): HTMLButtonElement => {
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!button) throw new Error(`No button "${text}"`);
  return button as HTMLButtonElement;
};

/** Runs the 600ms debounce and lets the validation promise settle. */
const settleValidation = async () => {
  await act(async () => {
    vi.advanceTimersByTime(700);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const renderDialog = (
  fetcher: RcdFetcher,
  over: Partial<Parameters<typeof MeasureDialog>[0]> = {},
) =>
  mount(
    fetcher,
    <MeasureDialog
      initial={MINE}
      definition={DEFINITION}
      dataSourceName="warehouse"
      catalog={null}
      siblings={DEFINITION.measures}
      folders={[]}
      onClose={() => {}}
      onSave={() => {}}
      {...over}
    />,
  );

describe('MeasureDialog live validation', () => {
  it('another measure’s broken formula does NOT block saving this one', async () => {
    // measures[0] is broken. The candidate is measures[1].
    const { fetcher } = makeFetcher([
      {
        code: 'MDL013',
        severity: 'error',
        message: "Measure 'Broken' expression references column 'nope'…",
        path: 'measures[0].expression',
      },
    ]);
    renderDialog(fetcher);
    await settleValidation();

    expect(buttonByText('Save').disabled).toBe(false);
    // …and the dialog does not print somebody else's problem either.
    expect(document.querySelector('[data-testid="rcd-measure-issues"]')).toBeNull();
  });

  it('blocks — and shows the message — when the server blames THIS measure', async () => {
    const { fetcher } = makeFetcher([
      {
        code: 'MDL013',
        severity: 'error',
        message: "Measure 'Mine' expression references column 'nope'…",
        path: 'measures[1].expression',
      },
    ]);
    renderDialog(fetcher);
    await settleValidation();

    expect(buttonByText('Save').disabled).toBe(true);
    expect(host.querySelector('[data-testid="rcd-measure-issues"]')?.textContent).toContain(
      'MDL013',
    );
  });

  it('a WARNING on this measure is shown but never blocks', async () => {
    const { fetcher } = makeFetcher([
      {
        code: 'MDL011',
        severity: 'warning',
        message: 'Heads up.',
        path: 'measures[1]',
      },
    ]);
    renderDialog(fetcher);
    await settleValidation();

    expect(host.querySelector('[data-testid="rcd-measure-issues"]')?.textContent).toContain(
      'Heads up.',
    );
    expect(buttonByText('Save').disabled).toBe(false);
  });

  it('a NEW measure is validated at its appended index, not at somebody else’s', async () => {
    // A creation is spliced onto the end: measures[2] of 3.
    const { fetcher, calls } = makeFetcher([
      {
        code: 'MDL012',
        severity: 'error',
        message: 'Does not parse.',
        path: 'measures[2].expression',
      },
    ]);
    renderDialog(fetcher, { initial: null });

    act(() => {
      // Switch to Calculation mode — the expression textarea only exists then.
      const calc = [...host.querySelectorAll('input[type="radio"]')][1] as HTMLInputElement;
      calc.click();
    });
    act(() => {
      // Re-queried AFTER the switch: in aggregation mode the only textarea is
      // Description, and typing a formula into it validates nothing.
      typeInto(host.querySelector('input') as HTMLInputElement, 'Brand new');
      typeInto(host.querySelector('textarea') as HTMLTextAreaElement, 'SUM(');
    });
    await settleValidation();

    const posted = calls.find((c) => c.path.endsWith('/models/validate'));
    const body = posted!.init!.body as { definition: ModelDefinition };
    expect(body.definition.measures).toHaveLength(3);
    expect(buttonByText('Add').disabled).toBe(true);
  });
});

describe('MeasureDialog duplicate names', () => {
  it('refuses a name another measure already uses, and says why', async () => {
    const { fetcher } = makeFetcher([]);
    renderDialog(fetcher, { initial: null });

    act(() => {
      // Same name as measures[0], different case.
      typeInto(host.querySelector('input') as HTMLInputElement, 'broken');
    });

    expect(host.textContent).toContain('Names must be unique');
    expect(buttonByText('Add').disabled).toBe(true);
  });

  it('a measure keeping its OWN name is not a duplicate', async () => {
    const { fetcher } = makeFetcher([]);
    renderDialog(fetcher, { initial: BROKEN });
    expect(host.textContent).not.toContain('Names must be unique');
  });
});

describe('MeasureDialog read-only mode', () => {
  it('disables every control and offers only Close', async () => {
    const { fetcher } = makeFetcher([]);
    renderDialog(fetcher, { readOnly: true, note: 'Managed by an administrator.' });

    expect(host.textContent).toContain('Managed by an administrator.');
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Close')).toBe(
      true,
    );
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Save')).toBe(
      false,
    );
    // ONE disabled <fieldset> wraps the whole body, which is what actually
    // disables every control inside it — including the ones nested components
    // own. (jsdom does not reflect inherited disabling on the child's IDL
    // property, so the fieldset is the honest thing to assert.)
    expect(host.querySelector('fieldset[disabled]')).not.toBeNull();
  });
});
