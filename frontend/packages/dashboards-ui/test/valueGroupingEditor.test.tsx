// @vitest-environment jsdom
/**
 * THE VALUE-GROUPING EDITOR — the owner's literal case, end to end.
 *
 * Reported, verbatim: a column holds "Yes" or a date, and the chart draws
 * "yes, (Blank), 02/03/2026, 04/22/2026, 12/15/2021, 08/28/2025". Wanted: two
 * bars — blank as "No", everything else as "Yes".
 *
 * The requirement was that this take under a minute, so the first test is a
 * literal stopwatch on the interaction count: OPEN, one click, APPLY. Anything
 * that grows that path fails here.
 *
 * The distinct-value picker is exercised against a STUBBED /query/values, both
 * because that is the point of it (the author picks values that exist rather
 * than typing them from memory) and because a rule built from typed values is
 * the one that silently matches nothing.
 */
import { act, useState } from 'react';

// react-dom requires an explicit opt-in for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DistinctValuesSpec,
  RcdFetcher,
  RcdRequestInit,
  ValueGrouping,
} from '@recon/dashboards-core';
import { DashboardsProvider } from '../src/provider/DashboardsProvider';
import { ValueGroupingEditor } from '../src/chart-builder/ValueGroupingEditor';

/** Every /query/values request the editor made, in order. */
let valueRequests: DistinctValuesSpec[] = [];

const fetcher = (<T,>(path: string, init?: RcdRequestInit): Promise<T> => {
  if (path.endsWith('/query/values')) {
    valueRequests.push(init?.body as DistinctValuesSpec);
    return Promise.resolve({
      values: ['yes', '2026-02-03', '2026-04-22', '2021-12-15'],
      hasMore: false,
    } as T);
  }
  if (path.endsWith('/meta')) return Promise.resolve({ canManageShared: false } as T);
  if (path.endsWith('/user-settings')) return Promise.resolve({ settings: {} } as T);
  return Promise.resolve({} as T);
}) as RcdFetcher;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  valueRequests = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const applied: (ValueGrouping | null)[] = [];

function Harness({
  initial = null,
  onPromote,
}: {
  initial?: ValueGrouping | null;
  onPromote?: (grouping: ValueGrouping) => void;
}) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <ValueGroupingEditor
      modelId={1}
      table="public.report_systems"
      column="uploaded_to_edms"
      label="Uploaded to EDMS"
      initial={initial}
      onPromote={onPromote}
      onApply={(grouping) => applied.push(grouping)}
      onClose={() => setOpen(false)}
    />
  );
}

const mount = async (props: Parameters<typeof Harness>[0] = {}) => {
  applied.length = 0;
  await act(async () => {
    root.render(
      <DashboardsProvider baseUrl="/api/rcd/v1" fetcher={fetcher}>
        <Harness {...props} />
      </DashboardsProvider>,
    );
  });
};

const buttonWith = (text: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (!found) throw new Error(`No button containing "${text}"`);
  return found as HTMLButtonElement;
};

const byLabel = (label: string): HTMLElement => {
  const found = host.querySelector(`[aria-label="${label}"]`);
  if (!found) throw new Error(`No element labelled "${label}"`);
  return found as HTMLElement;
};

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const type = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('the owner’s case', () => {
  it('is one click from the empty state, and produces exactly two bars', async () => {
    await mount();
    // The empty state says what the chart does TODAY, and offers the split.
    expect(host.textContent).toContain('one bar for every distinct value');
    await click(buttonWith('Blank vs. everything else'));
    await click(buttonWith('Apply'));

    expect(applied).toEqual([
      { groups: [{ label: 'No', matchBlank: true }], otherLabel: 'Yes' },
    ]);
  });

  it('the two labels are editable before applying', async () => {
    await mount();
    await click(buttonWith('Blank vs. everything else'));
    await type(byLabel('Name for group 1') as HTMLInputElement, 'Not uploaded');
    await type(byLabel('Name for everything else') as HTMLInputElement, 'Uploaded');
    await click(buttonWith('Apply'));

    expect(applied[0]).toEqual({
      groups: [{ label: 'Not uploaded', matchBlank: true }],
      otherLabel: 'Uploaded',
    });
  });
});

describe('the value picker', () => {
  it('reads REAL values from the server rather than asking the author to type them', async () => {
    await mount();
    await click(buttonWith('Start from a group of values'));

    expect(valueRequests).toMatchObject([
      { modelId: 1, table: 'public.report_systems', column: 'uploaded_to_edms' },
    ]);
    expect(host.textContent).toContain('2026-02-03');
  });

  it('a picked value lands in the group, and the rule carries it', async () => {
    await mount();
    await click(buttonWith('Start from a group of values'));
    const checkbox = [...host.querySelectorAll('input[type="checkbox"]')].find((input) =>
      (input.closest('label')?.textContent ?? '').includes('yes'),
    ) as HTMLInputElement;
    await click(checkbox);
    await type(byLabel('Name for group 1') as HTMLInputElement, 'Keyword');
    await click(buttonWith('Apply'));

    // otherLabel is ALWAYS written, even when the author left it blank: the
    // engine reads a missing one as "keep each unmatched value's own text",
    // while the UI calls that bucket "Other" — writing it is what stops the
    // chart and the label list from disagreeing.
    expect(applied[0]).toEqual({
      groups: [{ label: 'Keyword', values: ['yes'] }],
      otherLabel: 'Other',
    });
  });
});

describe('guards', () => {
  it('will not apply an unnamed group, and says what is wrong', async () => {
    await mount();
    await click(buttonWith('Blank vs. everything else'));
    await type(byLabel('Name for group 1') as HTMLInputElement, '  ');
    expect(buttonWith('Apply').disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'give every group a name',
    );
  });

  it('offers a way BACK to raw values once a grouping exists', async () => {
    await mount({ initial: { groups: [{ label: 'No', matchBlank: true }], otherLabel: 'Yes' } });
    await click(buttonWith('Remove grouping'));
    expect(applied).toEqual([null]);
  });
});

describe('promotion to a reusable field', () => {
  it('offers it, and hands over the finished rule rather than creating anything', async () => {
    const onPromote = vi.fn();
    await mount({ onPromote });
    await click(buttonWith('Blank vs. everything else'));
    await click(buttonWith('Make this a reusable field'));

    expect(onPromote).toHaveBeenCalledWith({
      groups: [{ label: 'No', matchBlank: true }],
      otherLabel: 'Yes',
    });
    // Nothing was applied to the chip: promoting is a different decision from
    // grouping this one chart, and the editor does not make it for the author.
    expect(applied).toEqual([]);
  });

  it('is not offered at all when the host does not wire it', async () => {
    await mount();
    await click(buttonWith('Blank vs. everything else'));
    expect(
      [...host.querySelectorAll('button')].some((b) =>
        (b.textContent ?? '').includes('Make this a reusable field'),
      ),
    ).toBe(false);
  });
});

/**
 * EXCEL-STYLE RULES in the editor. A listed bucket freezes the values that
 * existed when it was written; a rule keeps catching new ones, which is the
 * point — so the editor has to be able to express one without picking values.
 */
describe('match rules', () => {
  const selectOption = async (select: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setter.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it('a rule reaches the applied grouping, with no values picked at all', async () => {
    await mount();
    await click(buttonWith('Start from a group of values'));
    await type(byLabel('Name for group 1') as HTMLInputElement, 'Westlake');
    await click(buttonWith('+ Add rule'));
    await type(byLabel('Value for rule 1 of group 1') as HTMLInputElement, 'westlake');
    await click(buttonWith('Apply'));

    expect(applied[0]!.groups[0]).toEqual({
      label: 'Westlake',
      rules: [{ operator: 'contains', value: 'westlake' }],
    });
  });

  it('hides the value box for the operators that take none', async () => {
    await mount();
    await click(buttonWith('Start from a group of values'));
    await click(buttonWith('+ Add rule'));
    expect(byLabel('Value for rule 1 of group 1')).toBeTruthy();

    await selectOption(byLabel('Rule 1 for group 1') as HTMLSelectElement, 'isBlank');
    expect(() => byLabel('Value for rule 1 of group 1')).toThrow();
  });

  it('offers any/all only once there is more than one rule', async () => {
    await mount();
    await click(buttonWith('Start from a group of values'));
    await click(buttonWith('+ Add rule'));
    expect(() => byLabel('How rules combine for group 1')).toThrow();

    await click(buttonWith('+ Add rule'));
    expect(byLabel('How rules combine for group 1')).toBeTruthy();
  });

  it('will not apply a rule with no value, and says so', async () => {
    await mount();
    await click(buttonWith('Start from a group of values'));
    await type(byLabel('Name for group 1') as HTMLInputElement, 'Westlake');
    await click(buttonWith('+ Add rule'));

    expect(host.textContent).toContain('give every rule a value');
    expect(buttonWith('Apply').disabled).toBe(true);
  });
});
