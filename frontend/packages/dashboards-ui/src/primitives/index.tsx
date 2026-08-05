import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { X } from 'lucide-react';

// Minimal internal primitive set (hosts have no component library). Tailwind +
// rcd tokens only; literal class names throughout.

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Shared accent focus ring for every interactive control (keyboard only). */
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rcd-accent focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--rcd-bg)]';

const buttonClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-rcd-accent text-white shadow-[var(--rcd-shadow-1)] hover:opacity-90 disabled:opacity-50 disabled:shadow-none',
  secondary:
    'border border-rcd-border bg-rcd-surface text-rcd-text shadow-[var(--rcd-shadow-1)] hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50 disabled:shadow-none',
  ghost: 'text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40',
  danger:
    'bg-[var(--rcd-status-critical)] text-white shadow-[var(--rcd-shadow-1)] hover:opacity-90 disabled:opacity-50 disabled:shadow-none',
};

export interface RcdButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function RcdButton({ variant = 'secondary', className = '', type = 'button', ...rest }: RcdButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${FOCUS_RING} ${buttonClasses[variant]} ${className}`}
      {...rest}
    />
  );
}

export function RcdIconButton({ className = '', type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`rounded-md p-1.5 text-rcd-text-2 transition-colors hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10 disabled:opacity-40 ${FOCUS_RING} ${className}`}
      {...rest}
    />
  );
}

export function RcdInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-8 rounded-md border border-rcd-border bg-rcd-surface px-2.5 text-sm text-rcd-text outline-none transition-[border-color,box-shadow] duration-150 focus:border-rcd-accent focus:ring-2 focus:ring-[color-mix(in_srgb,var(--rcd-accent)_25%,transparent)] ${className}`}
      {...rest}
    />
  );
}

export function RcdSelect({ className = '', ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-8 rounded-md border border-rcd-border bg-rcd-surface px-2 text-sm text-rcd-text outline-none transition-[border-color,box-shadow] duration-150 focus:border-rcd-accent focus:ring-2 focus:ring-[color-mix(in_srgb,var(--rcd-accent)_25%,transparent)] ${className}`}
      {...rest}
    />
  );
}

export function RcdSpinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-rcd-muted" role="status">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-rcd-border border-t-rcd-accent" />
      {label ?? 'Loading…'}
    </div>
  );
}

export interface RcdDialogProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Title bar becomes a move handle. */
  draggable?: boolean;
  /** Bottom-right corner handle resizes the panel. */
  resizable?: boolean;
}

interface DialogPoint {
  x: number;
  y: number;
}

interface DialogSize {
  w: number;
  h: number;
}

const DIALOG_MIN_W = 480;
const DIALOG_MIN_H = 360;
const dialogMaxW = () => window.innerWidth * 0.95;
const dialogMaxH = () => window.innerHeight * 0.9;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

const clampDialogPos = (x: number, y: number, w: number, h: number): DialogPoint => ({
  x: clamp(x, 0, window.innerWidth - w),
  y: clamp(y, 0, window.innerHeight - h),
});

/**
 * Session-scoped memory for draggable/resizable dialogs: reopening restores the
 * last size/position (no persistence). Shared by all opted-in dialogs — today
 * only the chart-builder dialog opts in.
 */
let lastDialogGeometry: { pos: DialogPoint | null; size: DialogSize | null } | null = null;

/** Focus-trapped modal; Esc closes. No browser dialogs anywhere in the library. */
export function RcdDialog({ title, open, onClose, children, footer, wide, draggable, resizable }: RcdDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // null = default flex-centered / class-driven size. Once the user drags or
  // resizes, the panel switches to absolute positioning at the tracked x/y.
  const [pos, setPos] = useState<DialogPoint | null>(null);
  const [size, setSize] = useState<DialogSize | null>(null);
  const geometryRef = useRef<{ pos: DialogPoint | null; size: DialogSize | null }>({ pos: null, size: null });
  const dragState = useRef<{ dx: number; dy: number } | null>(null);
  const resizeState = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);
  const floating = Boolean(draggable || resizable);

  const applyPos = (next: DialogPoint) => {
    geometryRef.current.pos = next;
    setPos(next);
  };
  const applySize = (next: DialogSize) => {
    geometryRef.current.size = next;
    setSize(next);
  };
  const rememberGeometry = () => {
    if (floating) lastDialogGeometry = { ...geometryRef.current };
  };

  // Restore the session's last geometry on each open (re-clamped to the viewport).
  useEffect(() => {
    if (!open || !floating || !lastDialogGeometry) return;
    const remembered = lastDialogGeometry;
    let w: number | null = null;
    let h: number | null = null;
    if (remembered.size) {
      w = clamp(remembered.size.w, DIALOG_MIN_W, dialogMaxW());
      h = clamp(remembered.size.h, DIALOG_MIN_H, dialogMaxH());
      applySize({ w, h });
    }
    if (remembered.pos) applyPos(clampDialogPos(remembered.pos.x, remembered.pos.y, w ?? DIALOG_MIN_W, h ?? DIALOG_MIN_H));
  }, [open, floating]);

  const onTitlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggable) return;
    // Ignore drags starting on the close button (or any other control).
    if ((event.target as HTMLElement).closest('button')) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    applyPos({ x: rect.left, y: rect.top });
    dragState.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onTitlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    const panel = panelRef.current;
    if (!drag || !panel) return;
    const rect = panel.getBoundingClientRect();
    applyPos(clampDialogPos(event.clientX - drag.dx, event.clientY - drag.dy, rect.width, rect.height));
  };

  const onTitlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    dragState.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    rememberGeometry();
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    // Pin the current spot so growth goes right/down instead of re-centering.
    applyPos({ x: rect.left, y: rect.top });
    applySize({ w: rect.width, h: rect.height });
    resizeState.current = { startX: event.clientX, startY: event.clientY, startW: rect.width, startH: rect.height };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeState.current;
    if (!state) return;
    applySize({
      w: clamp(state.startW + (event.clientX - state.startX), DIALOG_MIN_W, dialogMaxW()),
      h: clamp(state.startH + (event.clientY - state.startY), DIALOG_MIN_H, dialogMaxH()),
    });
  };

  const onResizePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeState.current) return;
    resizeState.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    rememberGeometry();
  };

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Focus the first focusable element (not the panel), and never steal focus
    // when it is already inside the panel (e.g. an autoFocus input) — stealing
    // it dropped keystrokes from users clicking an input right after open.
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const firstFocusable = panel.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (firstFocusable ?? panel).focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
      if (event.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  // Inline geometry overrides the class-driven size/centering once the user
  // has dragged or resized (the overlay spans the viewport, so absolute
  // coordinates equal viewport coordinates).
  const panelStyle: CSSProperties = {
    ...(pos ? { position: 'absolute', left: pos.x, top: pos.y } : null),
    ...(size ? { width: size.w, height: size.h, maxWidth: '95vw', maxHeight: '90vh' } : null),
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={panelStyle}
        className={`relative z-10 flex max-h-[85vh] ${wide ? 'w-[56rem]' : 'w-[28rem]'} max-w-[92vw] flex-col rounded-[10px] border border-rcd-border bg-rcd-surface shadow-[var(--rcd-shadow-2)] outline-none`}
      >
        <div
          className={`flex items-center justify-between border-b border-rcd-border px-4 py-3 ${
            draggable ? 'cursor-move touch-none select-none' : ''
          }`}
          onPointerDown={onTitlePointerDown}
          onPointerMove={onTitlePointerMove}
          onPointerUp={onTitlePointerUp}
        >
          <h2 className="text-sm font-semibold text-rcd-text">{title}</h2>
          <RcdIconButton onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </RcdIconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-rcd-border px-4 py-3">{footer}</div>}
        {resizable && (
          <div
            aria-hidden
            className="absolute bottom-1 right-1 h-3.5 w-3.5 cursor-nwse-resize touch-none rounded-br-sm border-b-2 border-r-2 border-rcd-border hover:border-rcd-accent"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
          />
        )}
      </div>
    </div>
  );
}

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  open,
  onConfirm,
  onCancel,
  danger,
}: ConfirmDialogProps) {
  return (
    <RcdDialog
      title={title}
      open={open}
      onClose={onCancel}
      footer={
        <>
          <RcdButton onClick={onCancel}>Cancel</RcdButton>
          <RcdButton variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </RcdButton>
        </>
      }
    >
      <p className="text-sm text-rcd-text-2">{message}</p>
    </RcdDialog>
  );
}
