import { ArrowRightLeft, Copy, Eye, Pencil, Trash2 } from 'lucide-react';
import { MEASURE_MENU_SEPARATOR, type MeasureMenuItem } from './MeasureRowMenu';
import { transferVerb } from './measureActions';
import {
  otherScopes,
  scopeLabel,
  type MeasureScope,
  type MeasureScopeRights,
  type ScopedMeasure,
} from './measureScopes';

export interface MeasureMenuHandlers {
  onEdit: (entry: ScopedMeasure) => void;
  onDuplicate: (entry: ScopedMeasure) => void;
  onDelete: (entry: ScopedMeasure) => void;
  onTransfer: (entry: ScopedMeasure, to: MeasureScope) => void;
}

/**
 * ONE definition of what a measure row offers, used by the field list and by
 * the manager so the two can never drift.
 *
 * Every entry is always PRESENT; a right the caller lacks disables it and puts
 * the reason in the tooltip. That is the point of this wave's permission work:
 * the old model editor showed a fully live Edit on a built-in model and let the
 * save 403, and hiding the button instead would have replaced one confusion
 * ("why did that fail?") with another ("why can't I see it?").
 */
export const buildMeasureMenuItems = (
  entry: ScopedMeasure,
  rights: Record<MeasureScope, MeasureScopeRights>,
  handlers: MeasureMenuHandlers,
): (MeasureMenuItem | typeof MEASURE_MENU_SEPARATOR)[] => {
  const own = rights[entry.scope];
  const ownReason = own.canWrite ? undefined : (own.reason ?? undefined);

  const items: (MeasureMenuItem | typeof MEASURE_MENU_SEPARATOR)[] = [
    {
      key: 'edit',
      label: own.canWrite ? 'Edit…' : 'View…',
      icon: own.canWrite ? <Pencil size={12} /> : <Eye size={12} />,
      onSelect: () => handlers.onEdit(entry),
    },
    {
      key: 'duplicate',
      label: 'Duplicate',
      icon: <Copy size={12} />,
      disabled: !own.canWrite,
      title: ownReason,
      onSelect: () => handlers.onDuplicate(entry),
    },
    {
      key: 'delete',
      label: 'Delete…',
      icon: <Trash2 size={12} />,
      danger: true,
      disabled: !own.canWrite,
      title: ownReason,
      onSelect: () => handlers.onDelete(entry),
    },
    MEASURE_MENU_SEPARATOR,
  ];

  for (const target of otherScopes(entry.scope)) {
    const targetRights = rights[target];
    const verb = transferVerb(entry.scope, target);
    // Moving a measure OUT of a scope also writes that scope, so both ends
    // must be writable; a copy only writes the destination.
    const blocked = !targetRights.canWrite || (verb === 'move' && !own.canWrite);
    items.push({
      key: `to-${target}`,
      label: `${verb === 'move' ? 'Move to' : 'Copy to'} ${scopeLabel(target)}`,
      icon: verb === 'move' ? <ArrowRightLeft size={12} /> : <Copy size={12} />,
      disabled: blocked,
      title: blocked ? (targetRights.reason ?? ownReason) : undefined,
      onSelect: () => handlers.onTransfer(entry, target),
    });
  }

  return items;
};
