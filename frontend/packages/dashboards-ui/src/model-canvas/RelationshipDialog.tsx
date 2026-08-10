import { useState } from 'react';
import type { Cardinality, Relationship } from '@recon/dashboards-core';
import { ConfirmDialog, RcdButton, RcdDialog, RcdSelect } from '../primitives';

export interface RelationshipPatch {
  cardinality: Cardinality;
  isActive: boolean;
  /**
   * True when the user picked one-to-many: the wire format has no such value
   * ('from' is ALWAYS the many side), so the store swaps the endpoints and the
   * cardinality stays 'manyToOne'.
   */
  swapEndpoints: boolean;
}

export interface RelationshipDialogProps {
  relationship: Relationship;
  open: boolean;
  onClose: () => void;
  onSave: (patch: RelationshipPatch) => void;
  onDelete: () => void;
}

/** UI-only direction choice; 'oneToMany' maps to manyToOne + endpoint swap. */
type DirectionChoice = 'manyToOne' | 'oneToMany' | 'oneToOne';

function EndpointRow({
  role,
  glyph,
  table,
  column,
}: {
  role: string;
  glyph: string;
  table: string;
  column: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-rcd-border text-[10px] font-bold text-rcd-text-2"
      >
        {glyph}
      </span>
      <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-rcd-muted">
        {role}
      </span>
      <span className="min-w-0 break-all text-sm font-medium text-rcd-text">
        {table}.{column}
      </span>
    </div>
  );
}

/**
 * Edit dialog for one relationship: endpoints labeled with their live many/one
 * role, direction select (many-to-one / one-to-many / one-to-one), active
 * toggle, delete (confirmed) and save. One-to-many is expressed on save by
 * swapping the endpoints while the wire cardinality stays manyToOne. Draggable
 * with a light backdrop so the canvas stays readable behind it. Mount with
 * key={relationship.id} so local state reseeds per relationship.
 */
export function RelationshipDialog({
  relationship,
  open,
  onClose,
  onSave,
  onDelete,
}: RelationshipDialogProps) {
  const [direction, setDirection] = useState<DirectionChoice>(
    relationship.cardinality === 'oneToOne' ? 'oneToOne' : 'manyToOne',
  );
  const [isActive, setIsActive] = useState(relationship.isActive);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (confirmingDelete) {
    return (
      <ConfirmDialog
        title="Delete relationship"
        message={`Delete the relationship ${relationship.fromTable}.${relationship.fromColumn} → ${relationship.toTable}.${relationship.toColumn}? Charts that join through it may stop working.`}
        confirmLabel="Delete"
        danger
        open={open}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false);
          onDelete();
          onClose();
        }}
      />
    );
  }

  const fromRole = direction === 'manyToOne' ? 'Many side' : 'One side';
  const toRole = direction === 'oneToMany' ? 'Many side' : 'One side';
  const fromGlyph = direction === 'manyToOne' ? '*' : '1';
  const toGlyph = direction === 'oneToMany' ? '*' : '1';

  return (
    <RcdDialog
      title="Edit relationship"
      open={open}
      onClose={onClose}
      draggable
      backdropClassName="bg-black/10"
      footer={
        <>
          <RcdButton variant="danger" className="mr-auto" onClick={() => setConfirmingDelete(true)}>
            Delete
          </RcdButton>
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton
            variant="primary"
            onClick={() => {
              onSave({
                cardinality: direction === 'oneToOne' ? 'oneToOne' : 'manyToOne',
                isActive,
                swapEndpoints: direction === 'oneToMany',
              });
              onClose();
            }}
          >
            Save
          </RcdButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-rcd-border bg-rcd-bg px-3 py-2">
          <div className="flex flex-col gap-1.5">
            <EndpointRow
              role={fromRole}
              glyph={fromGlyph}
              table={relationship.fromTable}
              column={relationship.fromColumn}
            />
            <EndpointRow
              role={toRole}
              glyph={toGlyph}
              table={relationship.toTable}
              column={relationship.toColumn}
            />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="rounded border border-rcd-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-rcd-muted">
              {relationship.source === 'fk' ? 'Foreign key' : 'Manual'}
            </span>
            <span className="text-xs text-rcd-muted">
              {direction === 'oneToOne'
                ? 'One to one'
                : direction === 'oneToMany'
                  ? 'One side → many side'
                  : 'Many side → one side'}
            </span>
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-rcd-text-2">Cardinality</span>
          <RcdSelect
            value={direction}
            onChange={(event) => setDirection(event.target.value as DirectionChoice)}
          >
            <option value="manyToOne">Many to one (* : 1)</option>
            <option value="oneToMany">One to many (1 : *)</option>
            <option value="oneToOne">One to one (1 : 1)</option>
          </RcdSelect>
        </label>

        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 accent-[var(--rcd-accent)]"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
          />
          <span>
            <span className="block text-sm text-rcd-text">Active</span>
            <span className="block text-xs text-rcd-muted">
              Inactive relationships are ignored by queries; use to break ambiguous loops.
            </span>
          </span>
        </label>
      </div>
    </RcdDialog>
  );
}
