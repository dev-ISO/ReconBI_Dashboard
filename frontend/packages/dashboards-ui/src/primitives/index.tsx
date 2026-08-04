import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { X } from 'lucide-react';

// Minimal internal primitive set (hosts have no component library). Tailwind +
// rcd tokens only; literal class names throughout.

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonClasses: Record<ButtonVariant, string> = {
  primary: 'bg-rcd-accent text-white hover:opacity-90 disabled:opacity-50',
  secondary:
    'border border-rcd-border bg-rcd-surface text-rcd-text hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50',
  ghost: 'text-rcd-text-2 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40',
  danger: 'bg-[var(--rcd-status-critical)] text-white hover:opacity-90 disabled:opacity-50',
};

export interface RcdButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function RcdButton({ variant = 'secondary', className = '', type = 'button', ...rest }: RcdButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${buttonClasses[variant]} ${className}`}
      {...rest}
    />
  );
}

export function RcdIconButton({ className = '', type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`rounded-md p-1.5 text-rcd-text-2 hover:bg-black/5 hover:text-rcd-text dark:hover:bg-white/10 disabled:opacity-40 ${className}`}
      {...rest}
    />
  );
}

export function RcdInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`rounded-md border border-rcd-border bg-rcd-surface px-2.5 py-1.5 text-sm text-rcd-text outline-none focus:border-rcd-accent ${className}`}
      {...rest}
    />
  );
}

export function RcdSelect({ className = '', ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`rounded-md border border-rcd-border bg-rcd-surface px-2 py-1.5 text-sm text-rcd-text outline-none focus:border-rcd-accent ${className}`}
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
}

/** Focus-trapped modal; Esc closes. No browser dialogs anywhere in the library. */
export function RcdDialog({ title, open, onClose, children, footer, wide }: RcdDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative z-10 flex max-h-[85vh] ${wide ? 'w-[56rem]' : 'w-[28rem]'} max-w-[92vw] flex-col rounded-lg border border-rcd-border bg-rcd-surface shadow-xl outline-none`}
      >
        <div className="flex items-center justify-between border-b border-rcd-border px-4 py-3">
          <h2 className="text-sm font-semibold text-rcd-text">{title}</h2>
          <RcdIconButton onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </RcdIconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-rcd-border px-4 py-3">{footer}</div>}
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
