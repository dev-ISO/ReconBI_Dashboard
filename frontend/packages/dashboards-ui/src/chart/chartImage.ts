/**
 * Chart → PNG export ("Copy as image" / "Download image (2×)").
 *
 * Why this exists: people snip charts off the screen to paste into emails and
 * docs, and a snip is capped at monitor resolution — zooming it goes soft.
 * SVG charts can be re-rasterized at any density instead: clone the chart's
 * <svg>, inline the computed styles the clone would otherwise lose (recharts
 * paints via CSS variables and stylesheet rules that don't travel with a
 * serialized node), draw it onto a canvas at `scale`× the on-screen size, and
 * hand back a crisp PNG.
 *
 * Scope: SVG-rendered charts only (cartesian/pie/scatter/gantt). Table and
 * KPI tiles are HTML — rasterizing HTML needs a foreignObject/htmlcanvas
 * approach with different fidelity trade-offs; callers gate those types out.
 *
 * Fonts: an SVG rendered through <img> is a static, isolated document — it
 * cannot reach webfonts. The UI's font stack is system-first, so glyphs match
 * the screen for all practical purposes.
 */

/**
 * Computed-style properties that determine SVG paint. Inlined per element on
 * the clone: the live chart resolves these from stylesheets and CSS variables
 * (var(--rcd-*)), none of which exist inside the serialized document.
 */
const SVG_STYLE_PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'paint-order',
  'color',
  'visibility',
] as const;

/** Depth-first computed-style copy; source and clone trees are isomorphic. */
const inlineComputedStyles = (source: Element, target: Element): void => {
  const computed = window.getComputedStyle(source);
  let css = '';
  for (const property of SVG_STYLE_PROPS) {
    const value = computed.getPropertyValue(property);
    if (value !== '') css += `${property}:${value};`;
  }
  target.setAttribute('style', css);
  const sourceChildren = source.children;
  const targetChildren = target.children;
  for (let index = 0; index < sourceChildren.length; index++) {
    const targetChild = targetChildren[index];
    if (targetChild) inlineComputedStyles(sourceChildren[index]!, targetChild);
  }
};

/** The chart's SVG inside a tile root (recharts surface first, any svg else). */
export const findChartSvg = (root: HTMLElement | null): SVGSVGElement | null =>
  root?.querySelector<SVGSVGElement>('svg.recharts-surface') ??
  root?.querySelector<SVGSVGElement>('svg') ??
  null;

/** Nearest non-transparent ancestor background — the PNG's paper color. */
const surfaceColorBehind = (element: Element | null): string => {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const background = window.getComputedStyle(node).backgroundColor;
    if (background && background !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(background)) {
      return background;
    }
  }
  return '#ffffff';
};

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('SVG rasterization failed to load.'));
    image.src = url;
  });

/** Rasterize the chart SVG at `scale`× its rendered size onto its surface color. */
export async function chartSvgToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(svg, clone);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  const xml = new XMLSerializer().serializeToString(clone);
  // Same-origin blob URL: the canvas stays untainted, so toBlob is allowed.
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable.');
    context.fillStyle = surfaceColorBehind(svg);
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed.'))),
        'image/png',
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on a delay — revoking synchronously races the download start.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const safeFilename = (title: string): string => {
  const cleaned = title.replace(/[\\/:*?"<>|]+/g, ' ').trim();
  return cleaned === '' ? 'chart' : cleaned;
};

/**
 * Rasterize the WHOLE tile as rendered — header/inner title, legend, axis
 * titles, data labels, HTML renderers (table, KPI) included — via
 * html-to-image (bundled): it clones the subtree with computed styles inlined
 * and paints it through an SVG foreignObject at `pixelRatio`. Chrome-only
 * caveats don't apply here (tracker runs on Chrome), and tile chrome that
 * must never appear on an export (kebab, drag strips, drill buttons) is
 * tagged data-rcd-no-export and filtered out.
 */
export async function tileToPngBlob(tileRoot: HTMLElement, scale: number): Promise<Blob> {
  const { toBlob } = await import('html-to-image');
  const blob = await toBlob(tileRoot, {
    pixelRatio: scale,
    backgroundColor: surfaceColorBehind(tileRoot),
    filter: (node) =>
      !(node instanceof HTMLElement && node.hasAttribute('data-rcd-no-export')),
  });
  if (!blob) throw new Error('Tile rasterization produced no image.');
  return blob;
}

export type ImageExportArea = 'tile' | 'plot';
export type ImageExportMode = 'copy' | 'download';

/**
 * Export the chart tile as a PNG. Area 'tile' captures everything the tile
 * shows (title/inner title, legend, axis titles, labels — works for table and
 * KPI tiles too); 'plot' re-rasterizes just the chart's SVG (bare plot, SVG
 * chart types only). 'download' saves "<title>@<scale>x.png"; 'copy' puts the
 * PNG on the clipboard and falls back to a download when the clipboard
 * refuses (permissions, focus loss) so the user always ends up holding an
 * image. Resolves false only when there is nothing to export (stale tile).
 */
export async function exportChartImage(
  tileRoot: HTMLElement | null,
  title: string,
  mode: ImageExportMode,
  scale = 2,
  area: ImageExportArea = 'tile',
): Promise<boolean> {
  if (!tileRoot) return false;
  let blob: Blob;
  if (area === 'plot') {
    const svg = findChartSvg(tileRoot);
    if (!svg) return false;
    blob = await chartSvgToPngBlob(svg, scale);
  } else {
    blob = await tileToPngBlob(tileRoot, scale);
  }
  if (mode === 'copy') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch {
      /* clipboard unavailable — fall through to a download */
    }
  }
  downloadBlob(blob, `${safeFilename(title)}@${scale}x.png`);
  return true;
}
