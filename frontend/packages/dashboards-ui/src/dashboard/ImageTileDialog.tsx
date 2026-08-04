import { useEffect, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import type { ImageTileSpec } from '@recon/dashboards-core';
import { RcdButton, RcdDialog, RcdInput, RcdSelect } from '../primitives';

export interface ImageTileDialogProps {
  open: boolean;
  /** Dialog title: 'Add image' (new tile) or 'Change image' (config card). */
  title: string;
  /** Prefill for the change flow; null starts blank. */
  initial: ImageTileSpec | null;
  onClose: () => void;
  onSave: (spec: ImageTileSpec) => void;
}

/**
 * Encoded-upload hard cap. Layout docs are stored in a DB row capped at 512KB,
 * so one embedded image may take at most 400KB AFTER base64 encoding.
 */
const MAX_ENCODED_BYTES = 400 * 1024;

const FIT_OPTIONS: { value: ImageTileSpec['fit']; label: string }[] = [
  { value: 'contain', label: 'Contain (fit inside, keep ratio)' },
  { value: 'cover', label: 'Cover (fill tile, crop edges)' },
  { value: 'fill', label: 'Fill (stretch to tile)' },
];

const isValidSrc = (src: string): boolean =>
  /^data:image\//i.test(src) || /^https:\/\//i.test(src);

/**
 * Add/change dialog for image tiles: upload a file (encoded as a data URL,
 * hard-capped at 400KB) OR link an https URL, plus fit and alt text.
 */
export function ImageTileDialog({ open, title, initial, onClose, onSave }: ImageTileDialogProps) {
  const [src, setSrc] = useState('');
  const [fit, setFit] = useState<ImageTileSpec['fit']>('contain');
  const [alt, setAlt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // (Re)initialize from the incoming spec each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setSrc(initial?.src ?? '');
    setFit(initial?.fit ?? 'contain');
    setAlt(initial?.alt ?? '');
    setError(null);
  }, [open, initial]);

  const isUpload = /^data:/i.test(src);
  const valid = isValidSrc(src.trim());

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file (png, jpg, gif, svg, …).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (dataUrl.length > MAX_ENCODED_BYTES) {
        setError(
          `Encoded image is ${Math.ceil(dataUrl.length / 1024)} KB — the limit is 400 KB. ` +
            'Use a smaller image or link it by URL instead.',
        );
        return;
      }
      setError(null);
      setSrc(dataUrl);
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsDataURL(file);
  };

  const handleSave = () => {
    const trimmed = src.trim();
    if (!isValidSrc(trimmed)) return;
    onSave({
      src: trimmed,
      fit,
      ...(alt.trim() !== '' ? { alt: alt.trim() } : {}),
      // Background is owned by the tile's config card; the change flow keeps it.
      ...(initial?.background != null ? { background: initial.background } : {}),
    });
  };

  return (
    <RcdDialog
      title={title}
      open={open}
      onClose={onClose}
      footer={
        <>
          <RcdButton onClick={onClose}>Cancel</RcdButton>
          <RcdButton variant="primary" onClick={handleSave} disabled={!valid}>
            {title === 'Change image' ? 'Apply' : 'Add'}
          </RcdButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-rcd-text-2">Upload (max 400 KB encoded)</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              handleFile(event.target.files?.[0]);
              // Allow re-picking the same file after an error.
              event.target.value = '';
            }}
          />
          <div className="flex items-center gap-2">
            <RcdButton onClick={() => fileRef.current?.click()}>
              <Upload size={14} />
              Choose file…
            </RcdButton>
            {isUpload && (
              <span className="inline-flex items-center gap-1 rounded-full border border-rcd-border px-2 py-0.5 text-[11px] text-rcd-text-2">
                Encoded upload ({Math.ceil(src.length / 1024)} KB)
                <button
                  type="button"
                  aria-label="Remove uploaded image"
                  onClick={() => setSrc('')}
                  className="rounded-full p-0.5 text-rcd-muted hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10"
                >
                  <X size={11} />
                </button>
              </span>
            )}
          </div>
          {error && <p className="text-xs text-[var(--rcd-status-critical)]">{error}</p>}
        </div>

        <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
          Or image URL (https only)
          <RcdInput
            type="url"
            placeholder="https://example.com/logo.png"
            value={isUpload ? '' : src}
            disabled={isUpload}
            onChange={(event) => setSrc(event.target.value)}
            className="w-full disabled:opacity-50"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
          Fit
          <RcdSelect
            value={fit}
            onChange={(event) => setFit(event.target.value as ImageTileSpec['fit'])}
          >
            {FIT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </RcdSelect>
        </label>

        <label className="flex flex-col gap-1.5 text-xs font-medium text-rcd-text-2">
          Alt text (optional)
          <RcdInput
            value={alt}
            onChange={(event) => setAlt(event.target.value)}
            placeholder="Describes the image for screen readers"
            className="w-full"
          />
        </label>

        {valid && (
          <div className="flex max-h-40 items-center justify-center overflow-hidden rounded-md border border-rcd-border bg-rcd-bg p-2">
            <img src={src.trim()} alt="" className="max-h-36 max-w-full object-contain" />
          </div>
        )}
      </div>
    </RcdDialog>
  );
}
