/**
 * Collapsible cheat-sheet for the calculated-measure grammar (v2). Kept in
 * lock-step with the server parser: every construct listed here is one the
 * engine accepts, and the two footnotes call out the rules that are easiest
 * to trip over (PERCENTOFTOTAL nesting, ROUND's literal digit count).
 */

interface HelpEntry {
  /** Signature as the parser sees it. */
  signature: string;
  /** One-line, copy-pasteable example. */
  example: string;
  note?: string;
}

interface HelpGroup {
  title: string;
  entries: HelpEntry[];
}

const HELP_GROUPS: readonly HelpGroup[] = [
  {
    title: 'Aggregates',
    entries: [
      {
        signature: 'SUM / AVG / MIN / MAX / STDDEV / VARIANCE / MEDIAN (schema.table.column)',
        example: 'SUM(public.orders.total)',
      },
      { signature: 'COUNT(*)', example: 'COUNT(*)', note: 'counts rows' },
      {
        signature: 'COUNT / COUNTDISTINCT (schema.table.column)',
        example: 'COUNTDISTINCT(public.orders.customer_id)',
      },
    ],
  },
  {
    title: 'References & arithmetic',
    entries: [
      {
        signature: '[Measure name]',
        example: '[Revenue] / [Order count]',
        note: 'may reference other calculated measures — max chain depth 8, cycles rejected (MDL016)',
      },
      { signature: '+  −  *  /  ( )', example: '(SUM(public.orders.total) - SUM(public.orders.cost)) * 1.1' },
    ],
  },
  {
    title: 'Comparisons & logic',
    entries: [
      {
        signature: '=  <>  !=  >=  <=  >  <',
        example: 'SUM(public.orders.total) > 1000',
        note: 'booleans are only valid inside a condition — a measure cannot BE a comparison (MDL012)',
      },
      { signature: 'AND  OR  NOT  (or &&  ||  !)', example: '[Revenue] > 0 AND NOT [Returns] > 100' },
    ],
  },
  {
    title: 'Conditionals',
    entries: [
      {
        signature: 'IF(condition, then [, else])',
        example: 'IF([Revenue] > 0, [Profit] / [Revenue], 0)',
      },
      {
        signature: 'SWITCH(expr, v1, r1, … [, default])',
        example: 'SWITCH([Tier], 1, 0.1, 2, 0.2, 0)',
      },
    ],
  },
  {
    title: 'Math',
    entries: [
      {
        signature: 'DIVIDE(numerator, denominator [, alternate])',
        example: 'DIVIDE([Profit], [Revenue], 0)',
        note: 'safe divide — returns the alternate (or blank) instead of erroring on zero',
      },
      {
        signature: 'ROUND(x, digits)',
        example: 'ROUND([Margin], 2)',
        note: 'digits must be a whole-number LITERAL between -12 and 12 — not an expression',
      },
      { signature: 'ABS / CEILING / FLOOR / SQRT / EXP / LN (x)', example: 'ABS([Variance])' },
      { signature: 'POWER(x, y)', example: 'POWER([Growth], 2)' },
    ],
  },
  {
    title: 'Blanks',
    entries: [
      { signature: 'COALESCE(a, b, …)', example: 'COALESCE([Actual], [Forecast], 0)' },
      { signature: 'BLANK()', example: 'IF([Revenue] > 0, [Margin], BLANK())' },
    ],
  },
  {
    title: 'Share of total',
    entries: [
      {
        signature: 'PERCENTOFTOTAL(expression)',
        example: 'PERCENTOFTOTAL(SUM(public.orders.total))',
        note: 'must WRAP THE WHOLE expression — it cannot be nested inside arithmetic or another function, and other measures cannot reference a percent-of-total measure (MDL013)',
      },
    ],
  },
];

/** `<details>` cheat-sheet shown under the expression editor. */
export function ExpressionHelp() {
  return (
    <details className="rounded-md border border-rcd-border bg-rcd-surface">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-xs font-medium text-rcd-text-2">
        Function reference
      </summary>
      <div className="flex max-h-64 flex-col gap-3 overflow-y-auto border-t border-rcd-border px-2.5 py-2">
        {HELP_GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
              {group.title}
            </span>
            {group.entries.map((entry) => (
              <div key={entry.signature} className="flex flex-col leading-snug">
                <code className="font-mono text-[11px] text-rcd-text">{entry.signature}</code>
                <code className="font-mono text-[11px] text-rcd-accent">{entry.example}</code>
                {entry.note && <span className="text-[11px] text-rcd-muted">{entry.note}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}
