// Pure op machinery for collaborative editing (COLLAB-DESIGN wave 1):
//
//  - diffLayoutDocs(before, after)  → the ops one local mutation produced
//  - applyOpToDoc(doc, targetId, p) → the doc after one (remote/inverse) op
//  - invertLocalOp(before, op)      → the op that undoes `op` (live-mode
//                                     locally-scoped history entries)
//
// Diffing AT THE SEAMS (rather than hand-writing an emitter per store action)
// is the decorator the design asks for: every one of the ~35 mutations already
// funnels through mutateLayout / mutateActiveTiles / addPage / removePage, so
// a structural diff of the doc before/after each seam call provably covers the
// whole action catalog — including future actions — and can never emit an op
// that disagrees with what the local doc actually did.
//
// The emitted payloads ARE the backend's wire vocabulary verbatim (see
// types/ops.ts — the server's DashboardOpApplier is authoritative and its
// payloads are STRICT), and applyOpToDoc mirrors that applier's JSON surgery
// key for key: a sender's local application, the server's application, and
// every receiver's application of the broadcast payload must all be the same
// op. All three functions are PURE and treat docs as immutable (same
// conventions as the store's mutate* helpers: spread, never in-place).
import type {
  DashboardLayoutDoc,
  DashboardPage,
  DashboardTile,
} from '../types/dashboard';
import { isChartTile } from '../types/dashboard';
import type {
  DashboardLocalOp,
  DashboardOpPayload,
  DocElement,
  DocElementField,
  DocSettingKey,
  DocSettingValue,
  PageScalarPatch,
} from '../types/ops';
import { stableStringify } from '../util/hash';

const DOC_ELEMENT_FIELDS: DocElementField[] = ['filterCards', 'bookmarks', 'parameters'];
const DOC_SETTING_KEYS: DocSettingKey[] = [
  'refreshSeconds',
  'filterIndicator',
  'crossFilterScope',
  'defaultViewFit',
];

const pagesOf = (layout: DashboardLayoutDoc): DashboardPage[] => layout.pages ?? [];

const elementsOf = (layout: DashboardLayoutDoc, field: DocElementField): DocElement[] =>
  (layout[field] ?? []) as DocElement[];

const same = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

/** Tile content sans geometry — the "did anything but the layout change?" probe. */
const tileContentOf = (tile: DashboardTile): Omit<DashboardTile, 'layout'> => {
  const { layout: _geometry, ...content } = tile;
  return content;
};

/** Chart tiles are charts-class content; every other tile kind is layout-class
 * (the differ's rule: tile.layout→layout, chart→charts, static kinds→layout).
 * INTERNAL bookkeeping only — the wire carries no class (server classifies). */
const tileClass = (tile: DashboardTile): 'charts' | 'layout' =>
  isChartTile(tile) ? 'charts' : 'layout';

const tileOp = (
  cls: 'charts' | 'layout',
  tileId: string,
  payload: DashboardOpPayload,
): DashboardLocalOp => ({ class: cls, targetKind: 'tile', targetId: tileId, payload });

const pageOp = (pageId: string, payload: DashboardOpPayload): DashboardLocalOp => ({
  class: 'pages',
  targetKind: 'page',
  targetId: pageId,
  payload,
});

/** Doc-target op; pageReorder is pages-class, the rest layout-class. */
const docOp = (targetId: string | null, payload: DashboardOpPayload): DashboardLocalOp => ({
  class: payload.kind === 'pageReorder' ? 'pages' : 'layout',
  targetKind: 'doc',
  targetId,
  payload,
});

/**
 * The ops one seam-level mutation produced, derived structurally. Emission
 * order is application-safe for receivers: page adds first (so a reorder that
 * names a brand-new page and tile ops onto it land), then page prop changes +
 * the reorder, then tile ops, then page removals, then doc-element ops, then
 * doc-setting writes. Every op is per-element LWW, so relative order between
 * DIFFERENT elements is otherwise irrelevant.
 */
export const diffLayoutDocs = (
  before: DashboardLayoutDoc,
  after: DashboardLayoutDoc,
): DashboardLocalOp[] => {
  const ops: DashboardLocalOp[] = [];
  const beforePages = pagesOf(before);
  const afterPages = pagesOf(after);
  const beforeById = new Map(beforePages.map((page) => [page.id, page]));
  const afterIds = new Set(afterPages.map((page) => page.id));

  // Added pages (carry their tiles — normally empty; a fused add covers both).
  afterPages.forEach((page, index) => {
    if (!beforeById.has(page.id)) {
      ops.push(pageOp(page.id, { kind: 'pageAdd', page, index }));
    }
  });

  // Surviving pages: prop changes + per-page tile diffs.
  const tileOps: DashboardLocalOp[] = [];
  for (const page of afterPages) {
    const prior = beforeById.get(page.id);
    if (!prior) continue;
    if (prior.name !== page.name) {
      ops.push(pageOp(page.id, { kind: 'pageRename', name: page.name }));
    }
    if ((prior.color ?? null) !== (page.color ?? null)) {
      // The wire's "clear" is the color property ABSENT (strict payloads:
      // never null it out — omission is the removal signal).
      ops.push(
        pageOp(page.id, {
          kind: 'pageColor',
          ...(page.color != null ? { color: page.color } : {}),
        }),
      );
    }
    const patch: PageScalarPatch = {
      ...(same(prior.mobileLayout ?? null, page.mobileLayout ?? null)
        ? {}
        : { mobileLayout: page.mobileLayout ?? null }),
      ...(same(prior.drillthrough ?? null, page.drillthrough ?? null)
        ? {}
        : { drillthrough: page.drillthrough ?? null }),
    };
    if (Object.keys(patch).length > 0) {
      ops.push(pageOp(page.id, { kind: 'pageSet', patch }));
    }
    tileOps.push(...diffPageTiles(prior, page));
  }

  // Reorder: compared over the COMMON pages (adds/removes in the same
  // mutation must not read as moves) but emitted — per the wire contract — as
  // ONE doc-level op carrying the FULL after order; pages a stale receiver
  // doesn't know keep relative order at the end server-side.
  const beforeOrder = beforePages.filter((p) => afterIds.has(p.id)).map((p) => p.id);
  const afterOrder = afterPages.filter((p) => beforeById.has(p.id)).map((p) => p.id);
  if (beforeOrder.join(' ') !== afterOrder.join(' ')) {
    ops.push(docOp(null, { kind: 'pageReorder', pageIds: afterPages.map((p) => p.id) }));
  }

  ops.push(...tileOps);

  // Removed pages (their tiles die with them — one op, mirroring removePage).
  for (const page of beforePages) {
    if (!afterIds.has(page.id)) ops.push(pageOp(page.id, { kind: 'pageRemove' }));
  }

  // Id-keyed doc collections (filterCards / bookmarks / parameters).
  for (const field of DOC_ELEMENT_FIELDS) {
    const beforeElements = elementsOf(before, field);
    const afterElements = elementsOf(after, field);
    const beforeElById = new Map(beforeElements.map((el) => [el.id, el]));
    const afterElIds = new Set(afterElements.map((el) => el.id));
    for (const element of afterElements) {
      const prior = beforeElById.get(element.id);
      if (!prior || !same(prior, element)) {
        ops.push(docOp(element.id, { kind: 'docElementUpsert', field, element }));
      }
    }
    for (const element of beforeElements) {
      if (!afterElIds.has(element.id)) {
        ops.push(docOp(element.id, { kind: 'docElementRemove', field }));
      }
    }
  }

  // Doc-level scalars: ONE docSettingSet per changed key (wire contract).
  // The store's writers set null explicitly (never delete the key), so the
  // value always travels — null included; `value` omission (= remove the key)
  // is reserved for inverting an op that CREATED the key.
  for (const key of DOC_SETTING_KEYS) {
    if (!same(before[key] ?? null, after[key] ?? null)) {
      ops.push(
        docOp(null, { kind: 'docSettingSet', key, value: (after[key] ?? null) as DocSettingValue }),
      );
    }
  }

  return ops;
};

/** Tile ops for one surviving page (id-keyed: add/remove/geometry/content). */
const diffPageTiles = (before: DashboardPage, after: DashboardPage): DashboardLocalOp[] => {
  const ops: DashboardLocalOp[] = [];
  const beforeById = new Map(before.tiles.map((tile) => [tile.id, tile]));
  const afterIds = new Set(after.tiles.map((tile) => tile.id));
  for (const tile of after.tiles) {
    const prior = beforeById.get(tile.id);
    if (!prior) {
      // pageId places the ADD; the server ignores it on replace.
      ops.push(tileOp(tileClass(tile), tile.id, { kind: 'tileUpsert', tile, pageId: after.id }));
      continue;
    }
    const contentChanged = !same(tileContentOf(prior), tileContentOf(tile));
    if (contentChanged) {
      // A fused content+geometry change travels as ONE upsert (it carries the
      // full tile, layout included) — never a redundant geometry op on top.
      ops.push(tileOp(tileClass(tile), tile.id, { kind: 'tileUpsert', tile, pageId: after.id }));
    } else if (!same(prior.layout, tile.layout)) {
      ops.push(tileOp('layout', tile.id, { kind: 'tileGeometry', layout: tile.layout }));
    }
  }
  for (const tile of before.tiles) {
    if (!afterIds.has(tile.id)) {
      ops.push(tileOp(tileClass(tile), tile.id, { kind: 'tileRemove' }));
    }
  }
  return ops;
};

/** The page holding tile `tileId`, if any (tile ids are unique across pages). */
const pageOfTile = (
  layout: DashboardLayoutDoc,
  tileId: string,
): DashboardPage | undefined => pagesOf(layout).find((p) => p.tiles.some((t) => t.id === tileId));

const withPages = (
  layout: DashboardLayoutDoc,
  pages: DashboardPage[],
): DashboardLayoutDoc => ({ ...layout, pages });

const clampIndex = (index: number, length: number): number =>
  Math.min(Math.max(Math.trunc(index), 0), Math.max(length, 0));

/**
 * Applies one op to a layout doc — the receiving half of every op, shared by
 * applyRemoteOp and live-mode undo/redo, mirroring the server applier's JSON
 * surgery. Returns null when the op cannot apply to THIS doc (unknown
 * page/tile/element, unknown payload kind, last-page removal): id-keyed
 * reconciliation means an inapplicable op is simply dropped locally — the
 * reconnect-refetch doctrine repairs any real divergence.
 */
export const applyOpToDoc = (
  layout: DashboardLayoutDoc,
  targetId: string | null,
  payload: DashboardOpPayload,
): DashboardLayoutDoc | null => {
  switch (payload.kind) {
    case 'tileUpsert': {
      const tileId = payload.tile.id;
      const holder = pageOfTile(layout, tileId);
      if (holder) {
        // Replace in place wherever the tile lives — its id is the identity
        // (pageId is ignored on replace, matching the server).
        return withPages(
          layout,
          pagesOf(layout).map((page) =>
            page.id === holder.id
              ? { ...page, tiles: page.tiles.map((t) => (t.id === tileId ? payload.tile : t)) }
              : page,
          ),
        );
      }
      const target = pagesOf(layout).find((page) => page.id === payload.pageId);
      if (!target) return null;
      return withPages(
        layout,
        pagesOf(layout).map((page) =>
          page.id === payload.pageId ? { ...page, tiles: [...page.tiles, payload.tile] } : page,
        ),
      );
    }
    case 'tileRemove': {
      if (targetId === null) return null;
      const holder = pageOfTile(layout, targetId);
      if (!holder) return null; // idempotent no-op locally too
      return withPages(
        layout,
        pagesOf(layout).map((page) =>
          page.id === holder.id
            ? { ...page, tiles: page.tiles.filter((t) => t.id !== targetId) }
            : page,
        ),
      );
    }
    case 'tileGeometry': {
      if (targetId === null) return null;
      const holder = pageOfTile(layout, targetId);
      if (!holder) return null;
      return withPages(
        layout,
        pagesOf(layout).map((page) =>
          page.id === holder.id
            ? {
                ...page,
                tiles: page.tiles.map((t) =>
                  t.id === targetId ? { ...t, layout: payload.layout } : t,
                ),
              }
            : page,
        ),
      );
    }
    case 'pageAdd': {
      const pages = pagesOf(layout);
      // Idempotent re-add (echo/replay safety): an existing id is replaced.
      if (pages.some((p) => p.id === payload.page.id)) {
        return withPages(
          layout,
          pages.map((p) => (p.id === payload.page.id ? payload.page : p)),
        );
      }
      const next = [...pages];
      next.splice(clampIndex(payload.index ?? next.length, next.length), 0, payload.page);
      return withPages(layout, next);
    }
    case 'pageRename':
    case 'pageColor':
    case 'pageSet': {
      const pages = pagesOf(layout);
      if (!pages.some((p) => p.id === targetId)) return null;
      return withPages(
        layout,
        pages.map((page) => {
          if (page.id !== targetId) return page;
          if (payload.kind === 'pageRename') return { ...page, name: payload.name };
          if (payload.kind === 'pageColor') {
            // Property ABSENT removes the color (the server's rule); a null
            // that slipped through renders identically anyway.
            if (payload.color == null) {
              const { color: _removed, ...rest } = page;
              return rest;
            }
            return { ...page, color: payload.color };
          }
          // pageSet: shallow patch — null REMOVES the key, absent leaves it.
          let next: DashboardPage = page;
          if ('mobileLayout' in payload.patch) {
            if (payload.patch.mobileLayout === null) {
              const { mobileLayout: _removed, ...rest } = next;
              next = rest;
            } else {
              next = { ...next, mobileLayout: payload.patch.mobileLayout };
            }
          }
          if ('drillthrough' in payload.patch) {
            if (payload.patch.drillthrough === null) {
              const { drillthrough: _removed, ...rest } = next;
              next = rest;
            } else {
              next = { ...next, drillthrough: payload.patch.drillthrough };
            }
          }
          return next;
        }),
      );
    }
    case 'pageReorder': {
      const pages = pagesOf(layout);
      const byId = new Map(pages.map((p) => [p.id, p]));
      // Known ids follow the given order; pages the list does not know
      // (concurrent adds) keep relative order at the end — server semantics.
      const ordered = payload.pageIds
        .map((id) => byId.get(id))
        .filter((p): p is DashboardPage => p !== undefined);
      const orderedIds = new Set(ordered.map((p) => p.id));
      const rest = pages.filter((p) => !orderedIds.has(p.id));
      const next = [...ordered, ...rest];
      if (next.length !== pages.length) return null; // defensive — cannot happen
      return withPages(layout, next);
    }
    case 'pageRemove': {
      const pages = pagesOf(layout);
      // Mirror removePage's guard: a doc never drops its last page.
      if (pages.length <= 1 || !pages.some((p) => p.id === targetId)) return null;
      return withPages(
        layout,
        pages.filter((p) => p.id !== targetId),
      );
    }
    case 'docElementUpsert': {
      const elements = elementsOf(layout, payload.field);
      const index = elements.findIndex((el) => el.id === payload.element.id);
      const next = [...elements];
      if (index === -1) next.push(payload.element);
      else next[index] = payload.element;
      return { ...layout, [payload.field]: next };
    }
    case 'docElementRemove': {
      const elements = elementsOf(layout, payload.field);
      if (!elements.some((el) => el.id === targetId)) return null;
      return { ...layout, [payload.field]: elements.filter((el) => el.id !== targetId) };
    }
    case 'docSettingSet': {
      // `value` ABSENT removes the key (the server's rule); null stores null.
      if (payload.value === undefined) {
        const { [payload.key]: _removed, ...rest } = layout;
        return rest as DashboardLayoutDoc;
      }
      return { ...layout, [payload.key]: payload.value } as DashboardLayoutDoc;
    }
    default:
      // Unknown payload kind from a newer peer — drop; resync repairs.
      return null;
  }
};

/**
 * The op that UNDOES `op`, computed against the doc as it stood BEFORE the op
 * applied. This is the locally-scoped history entry of live mode: undo emits
 * the inverse through the same send pipeline, so it syncs like any edit.
 * Returns null when the op was a no-op against `before` (nothing to restore).
 */
export const invertLocalOp = (
  before: DashboardLayoutDoc,
  op: DashboardLocalOp,
): DashboardLocalOp | null => {
  const { payload } = op;
  switch (payload.kind) {
    case 'tileUpsert': {
      const holder = pageOfTile(before, payload.tile.id);
      const prior = holder?.tiles.find((t) => t.id === payload.tile.id);
      if (holder && prior) {
        return tileOp(tileClass(prior), prior.id, {
          kind: 'tileUpsert',
          tile: prior,
          pageId: holder.id,
        });
      }
      // The upsert ADDED the tile — the inverse removes it.
      return tileOp(tileClass(payload.tile), payload.tile.id, { kind: 'tileRemove' });
    }
    case 'tileRemove': {
      if (op.targetId === null) return null;
      const holder = pageOfTile(before, op.targetId);
      const prior = holder?.tiles.find((t) => t.id === op.targetId);
      if (!holder || !prior) return null;
      return tileOp(tileClass(prior), prior.id, {
        kind: 'tileUpsert',
        tile: prior,
        pageId: holder.id,
      });
    }
    case 'tileGeometry': {
      if (op.targetId === null) return null;
      const holder = pageOfTile(before, op.targetId);
      const prior = holder?.tiles.find((t) => t.id === op.targetId);
      if (!holder || !prior) return null;
      return tileOp('layout', prior.id, { kind: 'tileGeometry', layout: prior.layout });
    }
    case 'pageAdd':
      return pageOp(payload.page.id, { kind: 'pageRemove' });
    case 'pageRemove': {
      const pages = pagesOf(before);
      const index = pages.findIndex((p) => p.id === op.targetId);
      const prior = index === -1 ? undefined : pages[index];
      if (!prior) return null;
      return pageOp(prior.id, { kind: 'pageAdd', page: prior, index });
    }
    case 'pageRename': {
      const prior = pagesOf(before).find((p) => p.id === op.targetId);
      if (!prior) return null;
      return pageOp(prior.id, { kind: 'pageRename', name: prior.name });
    }
    case 'pageColor': {
      const prior = pagesOf(before).find((p) => p.id === op.targetId);
      if (!prior) return null;
      return pageOp(prior.id, {
        kind: 'pageColor',
        ...(prior.color != null ? { color: prior.color } : {}),
      });
    }
    case 'pageReorder':
      return docOp(null, { kind: 'pageReorder', pageIds: pagesOf(before).map((p) => p.id) });
    case 'pageSet': {
      const prior = pagesOf(before).find((p) => p.id === op.targetId);
      if (!prior) return null;
      // null in the inverse REMOVES what the op set (matching pageSet's own
      // null-removes rule — the store never persists explicit nulls here).
      const patch: PageScalarPatch = {
        ...('mobileLayout' in payload.patch ? { mobileLayout: prior.mobileLayout ?? null } : {}),
        ...('drillthrough' in payload.patch ? { drillthrough: prior.drillthrough ?? null } : {}),
      };
      return pageOp(prior.id, { kind: 'pageSet', patch });
    }
    case 'docElementUpsert': {
      const elements = elementsOf(before, payload.field);
      const prior = elements.find((el) => el.id === payload.element.id);
      if (prior) {
        return docOp(prior.id, { kind: 'docElementUpsert', field: payload.field, element: prior });
      }
      return docOp(payload.element.id, { kind: 'docElementRemove', field: payload.field });
    }
    case 'docElementRemove': {
      const prior = elementsOf(before, payload.field).find((el) => el.id === op.targetId);
      if (!prior) return null;
      return docOp(prior.id, { kind: 'docElementUpsert', field: payload.field, element: prior });
    }
    case 'docSettingSet': {
      // A key the doc didn't have inverts to REMOVAL (value omitted); an
      // existing value — null included — inverts to itself.
      const prior = before[payload.key];
      return docOp(null, {
        kind: 'docSettingSet',
        key: payload.key,
        ...(prior === undefined ? {} : { value: prior as DocSettingValue }),
      });
    }
    default:
      return null;
  }
};

/**
 * Coalescing-buffer merge: `next` lands on an element that already has a
 * pending unsent op. Per-element LWW makes "latest payload wins" correct in
 * every case except two: a geometry nudge arriving while a full-content
 * upsert is pending must fold INTO the upsert (it carries the whole tile —
 * replacing it with a bare geometry op would silently drop the content
 * change), and two pageSet patches union (they may touch different props).
 */
export const mergePendingPayloads = (
  prev: DashboardLocalOp,
  next: DashboardLocalOp,
): DashboardLocalOp => {
  if (prev.payload.kind === 'tileUpsert' && next.payload.kind === 'tileGeometry') {
    return {
      ...prev,
      payload: {
        ...prev.payload,
        tile: { ...prev.payload.tile, layout: next.payload.layout },
      },
    };
  }
  if (prev.payload.kind === 'pageSet' && next.payload.kind === 'pageSet') {
    return {
      ...next,
      payload: { kind: 'pageSet', patch: { ...prev.payload.patch, ...next.payload.patch } },
    };
  }
  return next;
};

/**
 * Pending-buffer slot key: ops that supersede each other share a slot. Tile
 * upsert/geometry share theirs (geometry folds INTO a pending upsert per the
 * merge above) but tileRemove holds its OWN slot — a remove must never
 * coalesce with an upsert: LWW-replacing a buffered content upsert with a
 * bare remove (or vice versa) silently drops the half that never reached the
 * wire, while separate slots send both in authored order (upsert-then-remove
 * and remove-then-re-add both replay exactly). Page prop families stay
 * separate (a rename must not clobber a pending recolor); doc elements share
 * per element; docSettingSet slots per SCALAR KEY (one wire op per key — a
 * defaultViewFit write must never swallow a pending refreshSeconds op);
 * pageReorder holds one doc-wide slot (latest full order wins).
 */
export const pendingSlotKey = (op: DashboardLocalOp): string => {
  const family =
    op.payload.kind === 'tileUpsert' || op.payload.kind === 'tileGeometry'
      ? 'tile'
      : op.payload.kind === 'docSettingSet'
        ? `docSettingSet:${op.payload.key}`
        : op.payload.kind;
  return `${op.targetKind} ${op.targetId ?? ''} ${family}`;
};
