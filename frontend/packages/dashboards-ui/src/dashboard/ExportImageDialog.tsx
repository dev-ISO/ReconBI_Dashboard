import { useState } from 'react';
import { Camera, ImageDown } from 'lucide-react';
import {
  exportChartImage,
  type ImageExportArea,
  type ImageExportMode,
} from '../chart/chartImage';
import { RcdButton, RcdDialog, RcdSelect } from '../primitives';

/**
 * Per-chart PNG export configuration ("Export image…" on the view-mode chart
 * menus). Area 'tile' captures EVERYTHING the tile shows — title or inner
 * title, legend, axis titles, data labels — and therefore also works for the
 * HTML renderers (table, KPI); 'plot' re-rasterizes just the chart SVG for a
 * bare embeddable plot, so it is offered only when the chart HAS one.
 * Choices persist for the session (module state, like PrintConfigDialog's).
 */
export interface ExportImageRequest {
  tileId: string;
  title: string;
  /** SVG chart types offer the bare-plot area; table/KPI are tile-only. */
  hasPlotSvg: boolean;
}

interface ExportChoices {
  area: ImageExportArea;
  scale: 1 | 2 | 3;
}

let sessionChoices: ExportChoices = { area: 'tile', scale: 2 };

const SCALE_LABEL: Record<ExportChoices['scale'], string> = {
  1: '1× (screen size)',
  2: '2× (crisp for documents)',
  3: '3× (large / projector)',
};

export function ExportImageDialog({
  request,
  resolveTileRoot,
  onClose,
}: {
  request: ExportImageRequest | null;
  /** DOM lookup owned by the caller (data-rcd-tile anchor). */
  resolveTileRoot: (tileId: string) => HTMLElement | null;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<ExportChoices>(sessionChoices);
  const [busy, setBusy] = useState<ImageExportMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (request === null) return null;
  // Plot-only is meaningless for HTML renderers; snap the persisted choice.
  const area: ImageExportArea = request.hasPlotSvg ? choices.area : 'tile';

  const run = async (mode: ImageExportMode) => {
    sessionChoices = { ...choices, area };
    setBusy(mode);
    setError(null);
    try {
      const ok = await exportChartImage(
        resolveTileRoot(request.tileId),
        request.title,
        mode,
        choices.scale,
        area,
      );
      if (!ok) {
        setError('Nothing to export — the chart is no longer on screen.');
        return;
      }
      onClose();
    } catch {
      setError('Image export failed — try again, or use Download instead of Copy.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <RcdDialog title={`Export image — ${request.title}`} open onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
          Include
          <RcdSelect
            value={area}
            disabled={!request.hasPlotSvg}
            onChange={(event) =>
              setChoices((current) => ({
                ...current,
                area: event.target.value as ImageExportArea,
              }))
            }
          >
            <option value="tile">Entire tile (title, legend, axis labels)</option>
            {request.hasPlotSvg && <option value="plot">Plot only (bare chart)</option>}
          </RcdSelect>
        </label>
        <label className="flex items-center justify-between gap-2 text-sm text-rcd-text-2">
          Resolution
          <RcdSelect
            value={String(choices.scale)}
            onChange={(event) =>
              setChoices((current) => ({
                ...current,
                scale: Number(event.target.value) as ExportChoices['scale'],
              }))
            }
          >
            {([1, 2, 3] as const).map((scale) => (
              <option key={scale} value={scale}>
                {SCALE_LABEL[scale]}
              </option>
            ))}
          </RcdSelect>
        </label>
        {error && (
          <p className="text-[11px] leading-4 text-[var(--rcd-status-warn)]" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <RcdButton onClick={() => void run('copy')} disabled={busy !== null}>
            <Camera size={14} />
            {busy === 'copy' ? 'Copying…' : 'Copy to clipboard'}
          </RcdButton>
          <RcdButton variant="primary" onClick={() => void run('download')} disabled={busy !== null}>
            <ImageDown size={14} />
            {busy === 'download' ? 'Rendering…' : 'Download PNG'}
          </RcdButton>
        </div>
      </div>
    </RcdDialog>
  );
}
