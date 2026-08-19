import type { SubscriptionDispatchSummary } from '@recon/dashboards-core';

/**
 * Shared bits between the per-dashboard Subscribe… dialog and the
 * Subscriptions & alerts manager: the "Last delivery" badge and the one-click
 * Enabled switch. A separate module (not SubscriptionsDialog) so the manager
 * can import them without creating a dialog↔manager import cycle.
 */

/** "2026-08-18 07:00 CT" — a UTC instant rendered as schedule-zone wall time
 * via Intl; unknown zone ids fall back to a raw UTC reading rather than lying
 * with the wrong offset (same policy as lastSentText). */
export const formatInstant = (utc: string, zoneId: string, zoneLabel: string): string => {
  const instant = new Date(/(?:[zZ]|[+-]\d\d:\d\d)$/.test(utc) ? utc : `${utc}Z`);
  if (Number.isNaN(instant.getTime())) return '';
  try {
    const stamp = new Intl.DateTimeFormat('en-CA', {
      timeZone: zoneId,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(instant)
      .replace(',', '');
    return `${stamp} ${zoneLabel}`;
  } catch {
    return `${instant.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
};

export type DeliveryTone = 'ok' | 'warn' | 'critical' | 'muted' | 'busy';

/**
 * Badge text + tone for a latest-dispatch summary. Exported for tests: this
 * mapping IS the "Last delivery" contract — `Sent 2026-08-18 07:00 CT`,
 * `Partial 2/3`, `Failed — SMTP timeout`, `Sending…`, `Skipped`, and
 * `Never delivered` for subscriptions with no dispatch yet.
 */
export const lastDeliveryText = (
  summary: SubscriptionDispatchSummary | null | undefined,
  zoneId: string,
  zoneLabel: string,
): { text: string; tone: DeliveryTone } => {
  if (!summary) return { text: 'Never delivered', tone: 'muted' };
  const stamp = formatInstant(summary.finishedUtc ?? summary.startedUtc, zoneId, zoneLabel);
  switch (summary.status) {
    case 'running':
      return { text: 'Sending…', tone: 'busy' };
    case 'sent':
      return { text: `Sent ${stamp}`, tone: 'ok' };
    case 'partial':
      return {
        text: `Partial ${summary.sentCount}/${summary.sentCount + summary.failedCount}${
          summary.error ? ` — ${summary.error}` : ''
        }`,
        tone: 'warn',
      };
    case 'failed':
      return { text: `Failed${summary.error ? ` — ${summary.error}` : ` ${stamp}`}`, tone: 'critical' };
    case 'skipped':
      return { text: `Skipped${summary.error ? ` — ${summary.error}` : ''}`, tone: 'muted' };
    default:
      return { text: stamp, tone: 'muted' };
  }
};

const TONE_CLASSES: Record<DeliveryTone, string> = {
  ok: 'border-rcd-border text-[var(--rcd-status-ok,#059669)]',
  warn: 'border-[var(--rcd-status-warn)] text-[var(--rcd-status-warn)]',
  critical: 'border-[var(--rcd-status-critical)] text-[var(--rcd-status-critical)]',
  muted: 'border-rcd-border text-rcd-muted',
  busy: 'border-rcd-border text-rcd-text-2',
};

export function DeliveryBadge({
  summary,
  zoneId,
  zoneLabel,
}: {
  summary: SubscriptionDispatchSummary | null | undefined;
  zoneId: string;
  zoneLabel: string;
}) {
  const { text, tone } = lastDeliveryText(summary, zoneId, zoneLabel);
  return (
    <span
      title={text}
      className={`inline-flex max-w-full items-center truncate rounded-md border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASSES[tone]}`}
    >
      {text}
    </span>
  );
}

/**
 * One-click pause/resume switch. Optimistic-free by design: the caller flips
 * the backend first and re-renders from the response, so the knob never lies
 * about what the scheduler will actually do.
 */
export function EnabledToggle({
  enabled,
  busy,
  label,
  onChange,
}: {
  enabled: boolean;
  busy?: boolean;
  label: string;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      title={enabled ? 'Enabled — click to pause' : 'Paused — click to enable'}
      disabled={busy}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full border transition-colors ${
        enabled
          ? 'border-[var(--rcd-accent)] bg-[var(--rcd-accent)]'
          : 'border-rcd-border bg-rcd-surface-2'
      } ${busy ? 'opacity-50' : 'cursor-pointer'}`}
      style={{ height: '18px', width: '32px' }}
    >
      <span
        className="inline-block rounded-full bg-white shadow transition-transform"
        style={{
          height: '12px',
          width: '12px',
          transform: enabled ? 'translateX(16px)' : 'translateX(3px)',
        }}
      />
    </button>
  );
}
