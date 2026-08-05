import { useMemo, useState } from 'react';
import {
  isNumericType,
  isTemporalType,
  type ColumnType,
  type FilterClause,
  type FilterOperator,
  type FilterValue,
} from '@recon/dashboards-core';
import { RcdButton, RcdDialog, RcdInput, RcdSelect } from '../primitives';
import { DistinctValueList } from './DistinctValueList';
import { OPERATOR_LABELS, operatorsFor } from './wellConfig';

export interface FilterEditorProps {
  modelId: number;
  table: string;
  column: string;
  /** Catalog type of the column; null when the catalog is unavailable. */
  columnType: ColumnType | null;
  /** Friendly column label for the dialog title. */
  label: string;
  /** Existing clause when editing a chip; null for a new filter. */
  initial: FilterClause | null;
  onApply: (clause: FilterClause) => void;
  onCancel: () => void;
}

type ValueMode = 'none' | 'single' | 'pair' | 'checklist' | 'boolean';

const valueModeFor = (operator: FilterOperator, type: ColumnType | null): ValueMode => {
  if (operator === 'isNull' || operator === 'notNull') return 'none';
  if (operator === 'between') return 'pair';
  if (operator === 'in' || operator === 'notIn') return 'checklist';
  if (type === 'boolean') return 'boolean';
  return 'single';
};

const inputTypeFor = (type: ColumnType | null): 'number' | 'date' | 'text' => {
  if (type !== null && isNumericType(type)) return 'number';
  if (type !== null && isTemporalType(type)) return 'date';
  return 'text';
};

/** '' for empty, null for unparseable, otherwise the wire value. */
const coerce = (raw: string, type: ColumnType | null): FilterValue | '' | null => {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (type !== null && isNumericType(type)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return trimmed; // dates arrive as 'YYYY-MM-DD' from <input type="date">
};

const initialText = (values: FilterValue[], index: number): string => {
  const value = values[index];
  return value === undefined || typeof value === 'boolean' ? '' : String(value);
};

/**
 * Operator + value editor for one FilterClause. Value inputs adapt to the
 * operator and column type; 'in' offers a searchable checklist of distinct
 * values. Nothing is written to the spec until Apply.
 */
export function FilterEditor({
  modelId,
  table,
  column,
  columnType,
  label,
  initial,
  onApply,
  onCancel,
}: FilterEditorProps) {
  const baseOperators = operatorsFor(columnType);
  const operators = useMemo(
    () =>
      initial && !baseOperators.includes(initial.operator)
        ? [initial.operator, ...baseOperators]
        : baseOperators,
    [initial, baseOperators],
  );

  const [operator, setOperator] = useState<FilterOperator>(
    initial?.operator ?? operators[0] ?? 'eq',
  );
  const [single, setSingle] = useState(() => (initial ? initialText(initial.values, 0) : ''));
  const [pairA, setPairA] = useState(() => (initial ? initialText(initial.values, 0) : ''));
  const [pairB, setPairB] = useState(() => (initial ? initialText(initial.values, 1) : ''));
  const [boolChoice, setBoolChoice] = useState<'true' | 'false'>(() =>
    initial?.values[0] === false ? 'false' : 'true',
  );
  const [selected, setSelected] = useState<FilterValue[]>(() =>
    initial && (initial.operator === 'in' || initial.operator === 'notIn') ? initial.values : [],
  );

  const mode = valueModeFor(operator, columnType);
  const inputType = inputTypeFor(columnType);

  const toggleSelected = (value: FilterValue) =>
    setSelected((current) =>
      current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    );

  const values = ((): FilterValue[] | null => {
    switch (mode) {
      case 'none':
        return [];
      case 'boolean':
        return [boolChoice === 'true'];
      case 'single': {
        const value = coerce(single, columnType);
        return value === '' || value === null ? null : [value];
      }
      case 'pair': {
        const from = coerce(pairA, columnType);
        const to = coerce(pairB, columnType);
        return from === '' || from === null || to === '' || to === null ? null : [from, to];
      }
      case 'checklist':
        return selected.length > 0 ? selected : null;
    }
  })();

  const apply = () => {
    if (values === null) return;
    onApply({ table, column, operator, values });
  };

  return (
    <RcdDialog
      title={`Filter: ${label}`}
      open
      onClose={onCancel}
      footer={
        <>
          <RcdButton onClick={onCancel}>Cancel</RcdButton>
          <RcdButton
            variant="primary"
            disabled={values === null}
            title={values === null ? 'Enter a value for this filter' : undefined}
            onClick={apply}
          >
            Apply
          </RcdButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
            Operator
          </span>
          <RcdSelect
            value={operator}
            onChange={(event) => setOperator(event.target.value as FilterOperator)}
            className="w-full max-w-[18rem]"
          >
            {operators.map((op) => (
              <option key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </option>
            ))}
          </RcdSelect>
        </label>

        {mode === 'single' && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
              Value
            </span>
            <RcdInput
              type={inputType}
              value={single}
              onChange={(event) => setSingle(event.target.value)}
              placeholder="Value"
              className="w-full max-w-[18rem]"
            />
          </label>
        )}

        {mode === 'pair' && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 max-w-[18rem] flex-1 basis-32 flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
                From
              </span>
              <RcdInput
                type={inputType}
                value={pairA}
                onChange={(event) => setPairA(event.target.value)}
                className="w-full"
              />
            </label>
            <span className="pb-2 text-xs text-rcd-muted">and</span>
            <label className="flex min-w-0 max-w-[18rem] flex-1 basis-32 flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
                To
              </span>
              <RcdInput
                type={inputType}
                value={pairB}
                onChange={(event) => setPairB(event.target.value)}
                className="w-full"
              />
            </label>
          </div>
        )}

        {mode === 'boolean' && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
              Value
            </span>
            <RcdSelect
              value={boolChoice}
              onChange={(event) => setBoolChoice(event.target.value as 'true' | 'false')}
              className="w-full max-w-[18rem]"
            >
              <option value="true">True</option>
              <option value="false">False</option>
            </RcdSelect>
          </label>
        )}

        {mode === 'checklist' && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
              Values
            </span>
            <DistinctValueList
              modelId={modelId}
              table={table}
              column={column}
              selected={selected}
              onToggle={toggleSelected}
            />
          </div>
        )}

        {mode === 'none' && (
          <p className="text-xs text-rcd-muted">This operator needs no value.</p>
        )}
      </div>
    </RcdDialog>
  );
}
