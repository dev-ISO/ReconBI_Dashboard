import { describe, expect, it } from 'vitest';
import type { DashboardAlert, SubscriptionDispatchSummary } from '@recon/dashboards-core';
import { formatInstant, lastDeliveryText } from '../src/dashboard/deliveryBadge';
import { alertConditionText } from '../src/dashboard/SubscriptionsManager';

/**
 * The "Last delivery" badge mapping IS the manager's at-a-glance contract
 * (Sent … / Partial 2/3 / Failed — error / Sending… / Never delivered), and
 * alertConditionText is the Alerts tab's one-line condition summary — both
 * pure, both pinned here.
 */

const summary = (over: Partial<SubscriptionDispatchSummary> = {}): SubscriptionDispatchSummary => ({
  dispatchId: 1,
  status: 'sent',
  trigger: 'schedule',
  startedUtc: '2026-08-18T12:00:00Z',
  finishedUtc: '2026-08-18T12:00:04Z',
  error: null,
  sentCount: 3,
  failedCount: 0,
  optedOutCount: 0,
  pendingCount: 0,
  ...over,
});

describe('lastDeliveryText', () => {
  it('reads "Never delivered" with no dispatch yet', () => {
    expect(lastDeliveryText(null, 'UTC', 'UTC')).toEqual({ text: 'Never delivered', tone: 'muted' });
    expect(lastDeliveryText(undefined, 'UTC', 'UTC').tone).toBe('muted');
  });

  it('stamps sent deliveries in the schedule zone', () => {
    const { text, tone } = lastDeliveryText(summary(), 'America/Chicago', 'CT');
    expect(text).toBe('Sent 2026-08-18 07:00 CT');
    expect(tone).toBe('ok');
  });

  it('shows partial as delivered/attempted with the first error', () => {
    const { text, tone } = lastDeliveryText(
      summary({ status: 'partial', sentCount: 2, failedCount: 1, error: 'SMTP timeout' }),
      'UTC',
      'UTC',
    );
    expect(text).toBe('Partial 2/3 — SMTP timeout');
    expect(tone).toBe('warn');
  });

  it('surfaces the failure error on failed deliveries', () => {
    const failed = lastDeliveryText(
      summary({ status: 'failed', sentCount: 0, failedCount: 3, error: 'SMTP timeout' }),
      'UTC',
      'UTC',
    );
    expect(failed.text).toBe('Failed — SMTP timeout');
    expect(failed.tone).toBe('critical');

    // No recorded error: fall back to the stamp, never "Failed — null".
    const bare = lastDeliveryText(summary({ status: 'failed', error: null }), 'UTC', 'UTC');
    expect(bare.text).toBe('Failed 2026-08-18 12:00 UTC');
  });

  it('reads running dispatches as Sending…', () => {
    expect(lastDeliveryText(summary({ status: 'running', finishedUtc: null }), 'UTC', 'UTC')).toEqual({
      text: 'Sending…',
      tone: 'busy',
    });
  });

  it('labels skipped occurrences with their reason', () => {
    const { text, tone } = lastDeliveryText(
      summary({ status: 'skipped', error: 'All recipients have opted out of this subscription.' }),
      'UTC',
      'UTC',
    );
    expect(text).toContain('Skipped — All recipients have opted out');
    expect(tone).toBe('muted');
  });
});

describe('formatInstant', () => {
  it('tolerates offsetless backend stamps by reading them as UTC', () => {
    expect(formatInstant('2026-08-18T12:00:00', 'UTC', 'UTC')).toBe('2026-08-18 12:00 UTC');
  });

  it('falls back to a raw UTC reading for unknown zone ids', () => {
    expect(formatInstant('2026-08-18T12:00:00Z', 'Not/AZone', 'XX')).toBe('2026-08-18 12:00 UTC');
  });
});

describe('alertConditionText', () => {
  const alert = (over: Partial<DashboardAlert> = {}): DashboardAlert =>
    ({
      id: 1,
      name: 'High sales',
      spec: {
        modelId: 1,
        dimensions: [],
        measures: [{ alias: 'Total sales' }],
        filters: [],
        sort: [],
      },
      operator: 'gt',
      threshold: 300,
      recipients: 'ops@example.com',
      everyMinutes: 60,
      cooldownMinutes: 60,
      enabled: true,
      ...over,
    }) as unknown as DashboardAlert;

  it('summarizes measure, operator, threshold, and cadence', () => {
    expect(alertConditionText(alert())).toBe('Total sales > 300 · every 1h');
  });

  it('falls back through measureId/column and reads sub-hour cadences in minutes', () => {
    const byColumn = alert({
      spec: { modelId: 1, dimensions: [], measures: [{ column: 'order_total' }], filters: [], sort: [] },
      operator: 'lte',
      everyMinutes: 15,
    } as unknown as Partial<DashboardAlert>);
    expect(alertConditionText(byColumn)).toBe('order_total ≤ 300 · every 15m');

    const noMeasure = alert({
      spec: { modelId: 1, dimensions: [], measures: [], filters: [], sort: [] },
    } as unknown as Partial<DashboardAlert>);
    expect(alertConditionText(noMeasure)).toContain('value > 300');
  });
});
