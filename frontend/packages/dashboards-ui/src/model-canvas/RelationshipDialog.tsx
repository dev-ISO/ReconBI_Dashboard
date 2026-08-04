import { useState } from 'react';
import { MoveRight } from 'lucide-react';
import type { Cardinality, Relationship } from '@recon/dashboards-core';
import { ConfirmDialog, RcdButton, RcdDialog, RcdSelect } from '../primitives';

export interface RelationshipPatch {
  cardinality: Cardinality;
  isActive: boolean;
}

export interface RelationshipDialogProps {
  relationship: Relationship;
  open: boolean;
  onClose: () => void;
  onSave: (patch: RelationshipPatch) => void;
  onDelete: () => void;
}

/**
 * Edit dialog for one relationship: endpoints read-only, cardinality select,
 * active toggle, delete (confirmed) and save. Mount with key={relationship.id}
 * so local state reseeds per relationship.
 */
export function RelationshipDialog({
  relationship,
  open,
  onClose,
  onSave,
  onDelete,
}: RelationshipDialogProps) {
  const [cardinality, setCardinality] = useState<Cardinality>(relationship.cardinality);
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

  return (
    <RcdDialog
      title="Edit relationship"
      open={open}
      onClose={onClose}
      footer={
        <>
          <RcdButton variant="danger" className="mr-auto" onClick={() => setConfirmingDelete(true)}>
            Delete
          </RcdButton>
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton
            variant="primary"
            onClick={() => {
              onSave({ cardinality, isActive });
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
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="break-all font-medium text-rcd-text">
              {relationship.fromTable}.{relationship.fromColumn}
            </span>
            <MoveRight size={14} className="shrink-0 text-rcd-muted" />
            <span className="break-all font-medium text-rcd-text">
              {relationship.toTable}.{relationship.toColumn}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="rounded border border-rcd-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-rcd-muted">
              {relationship.source === 'fk' ? 'Foreign key' : 'Manual'}
            </span>
            <span className="text-xs text-rcd-muted">
              {cardinality === 'manyToOne' ? 'Many side → one side' : 'One to one'}
            </span>
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-rcd-text-2">Cardinality</span>
          <RcdSelect
            value={cardinality}
            onChange={(event) => setCardinality(event.target.value as Cardinality)}
          >
            <option value="manyToOne">Many to one (* — 1)</option>
            <option value="oneToOne">One to one (1 — 1)</option>
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
