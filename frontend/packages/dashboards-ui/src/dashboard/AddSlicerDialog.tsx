import { useEffect, useMemo, useState } from 'react';
import {
  isQueryableType,
  isTemporalType,
  tableKey,
  type SlicerVariant,
} from '@recon/dashboards-core';
import { useModelState, useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdInput, RcdSelect } from '../primitives';

export interface AddSlicerDialogProps {
  open: boolean;
  /** The dashboard's model id — the slicer sources its values from this model. */
  modelId: number;
  onClose: () => void;
}

const VARIANT_OPTIONS: { value: SlicerVariant; label: string }[] = [
  { value: 'checklist', label: 'Checklist' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'dropdownMulti', label: 'Dropdown (multi-select)' },
  { value: 'buttons', label: 'Buttons' },
  { value: 'dateRange', label: 'Date range' },
];

/**
 * Table + column + label + variant picker for a new slicer TILE. Tables come
 * from the open model definition, columns from the catalog. Value-pick
 * variants (checklist/dropdown/buttons) list text columns; the date-range
 * variant lists date/timestamp columns instead.
 */
export function AddSlicerDialog({ open, modelId, onClose }: AddSlicerDialogProps) {
  const runtime = useRuntime();
  const openModel = useModelState((state) => state.current);
  const catalog = useModelState((state) => state.catalog);
  const catalogStatus = useModelState((state) => state.catalogStatus);

  const [table, setTable] = useState('');
  const [column, setColumn] = useState('');
  const [label, setLabel] = useState('');
  const [labelTouched, setLabelTouched] = useState(false);
  const [variant, setVariant] = useState<SlicerVariant>('checklist');

  useEffect(() => {
    if (!open) return;
    setTable('');
    setColumn('');
    setLabel('');
    setLabelTouched(false);
    setVariant('checklist');
  }, [open]);

  const modelReady = openModel !== null && openModel.id === modelId;
  const usableCatalog =
    modelReady && catalogStatus === 'ok' && catalog && catalog.connection === openModel.dataSourceName
      ? catalog
      : null;

  const tables = useMemo(
    () => (modelReady ? openModel.definition.tables.filter((t) => !t.hidden) : []),
    [modelReady, openModel],
  );

  const wantTemporal = variant === 'dateRange';

  const columns = useMemo(() => {
    if (!usableCatalog || !table) return [];
    const modelTable = tables.find((t) => tableKey(t.schema, t.name) === table);
    const overrides = new Map((modelTable?.columns ?? []).map((c) => [c.name, c]));
    return (usableCatalog.tables.find((t) => t.key === table)?.columns ?? [])
      .filter(
        (c) =>
          (wantTemporal ? isTemporalType(c.type) : c.type === 'text') &&
          isQueryableType(c.type) &&
          !overrides.get(c.name)?.hidden,
      )
      .map((c) => ({ name: c.name, label: overrides.get(c.name)?.friendlyName ?? c.name }));
  }, [usableCatalog, table, tables, wantTemporal]);

  const handleTable = (next: string) => {
    setTable(next);
    setColumn('');
    if (!labelTouched) setLabel('');
  };

  const handleColumn = (next: string) => {
    setColumn(next);
    if (!labelTouched) {
      setLabel(columns.find((c) => c.name === next)?.label ?? next);
    }
  };

  const handleVariant = (next: SlicerVariant) => {
    const temporalChanged = (next === 'dateRange') !== wantTemporal;
    setVariant(next);
    // The column list switches between text and date/timestamp columns; a
    // previously chosen column of the other kind is no longer valid.
    if (temporalChanged) {
      setColumn('');
      if (!labelTouched) setLabel('');
    }
  };

  const canAdd = table !== '' && column !== '' && label.trim() !== '';

  const handleAdd = () => {
    if (!canAdd) return;
    runtime.dashboards.addSlicer({ table, column, label: label.trim(), variant });
    onClose();
  };

  return (
    <RcdDialog
      title="Add slicer"
      open={open}
      onClose={onClose}
      footer={
        <>
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton variant="primary" disabled={!canAdd} onClick={handleAdd}>
            Add slicer
          </RcdButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {!modelReady ? (
          <p className="text-sm text-rcd-text-2">Loading the dashboard&apos;s model…</p>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
              Style
              <RcdSelect
                value={variant}
                onChange={(event) => handleVariant(event.target.value as SlicerVariant)}
              >
                {VARIANT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </RcdSelect>
            </label>

            <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
              Table
              <RcdSelect value={table} onChange={(event) => handleTable(event.target.value)}>
                <option value="">Choose a table…</option>
                {tables.map((t) => {
                  const key = tableKey(t.schema, t.name);
                  return (
                    <option key={key} value={key}>
                      {t.friendlyName ?? t.name}
                    </option>
                  );
                })}
              </RcdSelect>
            </label>

            <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
              Column
              <RcdSelect
                value={column}
                onChange={(event) => handleColumn(event.target.value)}
                disabled={table === '' || usableCatalog === null}
              >
                <option value="">Choose a column…</option>
                {columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.label}
                  </option>
                ))}
              </RcdSelect>
              {table !== '' && usableCatalog === null && (
                <span className="text-xs text-rcd-muted">
                  {catalogStatus === 'error'
                    ? 'Could not load the column catalog.'
                    : 'Loading columns…'}
                </span>
              )}
              {table !== '' && usableCatalog !== null && columns.length === 0 && (
                <span className="text-xs text-rcd-muted">
                  {wantTemporal
                    ? 'This table has no date columns for a date-range slicer.'
                    : 'This table has no text columns to slice by.'}
                </span>
              )}
            </label>

            <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
              Label
              <RcdInput
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setLabelTouched(true);
                }}
                placeholder="Shown on the slicer tile"
              />
            </label>
          </>
        )}
      </div>
    </RcdDialog>
  );
}
