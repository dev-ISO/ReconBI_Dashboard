import { useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Sigma } from 'lucide-react';
import {
  isRunnable,
  stableStringify,
  type Catalog,
  type ChartSpec,
  type ModelDefinition,
} from '@recon/dashboards-core';
import { ChartTile } from '../chart/ChartTile';
import { ConfirmDialog, RcdButton, RcdInput } from '../primitives';
import { ChartTypePicker } from './ChartTypePicker';
import { FieldList } from './FieldList';
import { Wells } from './Wells';
import { applyDrop, defaultWellFor, type FieldDragData, type WellId } from './wellConfig';

export interface ChartBuilderProps {
  modelId: number;
  model: ModelDefinition;
  initial: ChartSpec;
  onSave: (spec: ChartSpec) => void;
  onCancel: () => void;
  /** Column metadata for the model's data source; FieldList falls back to measures when null. */
  catalog?: Catalog | null;
}

/** Field list | title + type picker + wells | live preview. */
export function ChartBuilder({ modelId, model, initial, onSave, onCancel, catalog }: ChartBuilderProps) {
  const [draft, setDraft] = useState<ChartSpec>(() => structuredClone(initial));
  const [activeDrag, setActiveDrag] = useState<FieldDragData | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const lastDragEndAt = useRef(0);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const dirty = useMemo(
    () => stableStringify(draft) !== stableStringify(initial),
    [draft, initial],
  );

  const addToWell = (well: WellId, data: FieldDragData) =>
    setDraft((current) => ({ ...current, query: applyDrop(current.query, well, data) }));

  const handleDragStart = (event: DragStartEvent) =>
    setActiveDrag((event.active.data.current as FieldDragData | undefined) ?? null);

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null);
    lastDragEndAt.current = Date.now();
    const data = event.active.data.current as FieldDragData | undefined;
    const wellId = (event.over?.data.current as { wellId?: WellId } | undefined)?.wellId;
    if (data && wellId) addToWell(wellId, data);
  };

  const handleDragCancel = () => {
    setActiveDrag(null);
    lastDragEndAt.current = Date.now();
  };

  const handleClickAdd = (data: FieldDragData) => {
    // Ignore the synthetic click that follows a completed drag.
    if (Date.now() - lastDragEndAt.current < 250) return;
    addToWell(defaultWellFor(draft.query, data), data);
  };

  const handleCancel = () => {
    if (dirty) setConfirmCancel(true);
    else onCancel();
  };

  return (
    <div className="flex h-[34rem] flex-col gap-3">
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)_minmax(0,1.1fr)] gap-3">
          <div className="min-h-0 overflow-y-auto rounded-md border border-rcd-border bg-rcd-surface">
            <FieldList model={model} catalog={catalog ?? null} onAdd={handleClickAdd} />
          </div>

          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
                Title
              </span>
              <RcdInput
                value={draft.title}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="Chart title"
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
                Chart type
              </span>
              <ChartTypePicker
                value={draft.type}
                onChange={(type) => setDraft((current) => ({ ...current, type }))}
              />
            </div>

            <Wells
              chartType={draft.type}
              query={draft.query}
              model={model}
              catalog={catalog ?? null}
              onChange={(query) => setDraft((current) => ({ ...current, query }))}
            />
          </div>

          <div className="flex min-h-0 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-rcd-muted">
              Preview
            </span>
            <div className="min-h-0 flex-1 rounded-md border border-rcd-border bg-rcd-surface p-2">
              <ChartTile spec={draft} modelId={modelId} debounceMs={300} />
            </div>
          </div>
        </div>

        <DragOverlay dropAnimation={null}>
          {activeDrag && (
            <div className="flex w-max items-center gap-1.5 rounded-md border border-rcd-accent bg-rcd-surface px-2 py-1 text-xs font-medium text-rcd-text shadow-md">
              {activeDrag.kind === 'measure' && <Sigma size={12} className="text-rcd-muted" />}
              {activeDrag.kind === 'measure' ? activeDrag.name : activeDrag.column}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <div className="flex items-center justify-end gap-2 border-t border-rcd-border pt-3">
        <RcdButton onClick={handleCancel}>Cancel</RcdButton>
        <RcdButton
          variant="primary"
          disabled={!isRunnable(draft)}
          title={isRunnable(draft) ? undefined : 'Add at least one measure to the Values well'}
          onClick={() => onSave(draft)}
        >
          Save chart
        </RcdButton>
      </div>

      <ConfirmDialog
        title="Discard chart changes"
        message="This chart has unsaved changes. Discard them?"
        confirmLabel="Discard"
        danger
        open={confirmCancel}
        onConfirm={() => {
          setConfirmCancel(false);
          onCancel();
        }}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}
