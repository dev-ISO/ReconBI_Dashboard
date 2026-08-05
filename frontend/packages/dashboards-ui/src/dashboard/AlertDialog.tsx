import { useEffect, useMemo, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import {
  toWireSpec,
  type AlertOperator,
  type ChartQuerySpec,
  type ChartSpec,
  type FilterClause,
  type SaveAlertBody,
} from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdInput, RcdSelect } from '../primitives';
import { looksLikeEmail, parseRecipients } from './SubscriptionsDialog';

/** What the invoking context menu captured about the chart. */
export interface AlertSource {
  /** EFFECTIVE (param-substituted + drilled) chart at invocation time. */
  chart: ChartSpec;
  /** Dashboard-level filters merged into the tile's fetch at invocation time. */
  filters: FilterClause[];
}

export interface AlertDialogProps {
  open: boolean;
  dashboardId: number;
  modelId: number;
  source: AlertSource | null;
  onClose: () => void;
  /** Failures surface through the dashboard's transient notice chip. */
  onError: (message: string) => void;
}

const OPERATORS: { value: AlertOperator; label: string }[] = [
  { value: 'gt', label: 'is greater than' },
  { value: 'gte', label: 'is at least' },
  { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' },
  { value: 'eq', label: 'equals' },
];

const CADENCE_OPTIONS = [5, 15, 30, 60, 240, 1440];

/** Display name of a measure ref (alias > model measure id > column agg). */
const measureLabel = (chart: ChartSpec, index: number): string => {
  const measure = chart.query.measures[index];
  if (!measure) return `Measure ${index + 1}`;
  if (measure.alias) return measure.alias;
  if (measure.measureId) return measure.measureId;
  return `${measure.aggregation ?? 'sum'}(${measure.column ?? measure.table ?? '?'})`;
};

/**
 * "Set alert on this measure" dialog: a 0-dimension, 1-measure spec built from
 * the tile's EFFECTIVE filters + chosen measure, with operator / threshold /
 * recipients / cadence / cooldown. "Test now" uses the backend's saved-alert
 * test endpoint: the alert is saved first (create-or-update), then tested,
 * and editing continues — subsequent saves update the same alert.
 */
export function AlertDialog({ open, dashboardId, modelId, source, onClose, onError }: AlertDialogProps) {
  const runtime = useRuntime();

  const [alertId, setAlertId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [measureIndex, setMeasureIndex] = useState(0);
  const [operator, setOperator] = useState<AlertOperator>('gt');
  const [threshold, setThreshold] = useState('0');
  const [recipientsText, setRecipientsText] = useState('');
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [cooldownMinutes, setCooldownMinutes] = useState(60);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [testResult, setTestResult] = useState<{ value: number | null; wouldFire: boolean } | null>(null);

  // Re-prefill from the clicked chart on each open.
  useEffect(() => {
    if (!open || !source) return;
    setAlertId(null);
    setName(`${source.chart.title} alert`);
    setMeasureIndex(0);
    setOperator('gt');
    setThreshold('0');
    setRecipientsText('');
    setEveryMinutes(60);
    setCooldownMinutes(60);
    setEnabled(true);
    setBusy(null);
    setTestResult(null);
  }, [open, source]);

  const measures = source?.chart.query.measures ?? [];

  /** The 0-dim, 1-measure wire spec the alert watches. */
  const alertSpec = useMemo<ChartQuerySpec | null>(() => {
    if (!source || measures.length === 0) return null;
    const measure = measures[Math.min(measureIndex, measures.length - 1)];
    if (!measure) return null;
    return toWireSpec(
      {
        ...source.chart,
        query: {
          ...source.chart.query,
          axis: null,
          legend: null,
          smallMultiples: null,
          measures: [measure],
          sort: [],
          limit: null,
        },
      },
      modelId,
      source.filters,
    );
  }, [source, measures, measureIndex, modelId]);

  const recipients = parseRecipients(recipientsText);
  const invalidRecipients = recipients.filter((email) => !looksLikeEmail(email));
  const thresholdNumber = Number(threshold);
  const canSave =
    alertSpec !== null &&
    name.trim() !== '' &&
    Number.isFinite(thresholdNumber) &&
    recipients.length > 0 &&
    invalidRecipients.length === 0;

  const buildBody = (): SaveAlertBody | null => {
    if (!alertSpec || !canSave) return null;
    return {
      dashboardId,
      name: name.trim(),
      spec: alertSpec,
      operator,
      threshold: thresholdNumber,
      recipients,
      everyMinutes,
      cooldownMinutes,
      enabled,
    };
  };

  /** Create-or-update; returns the saved id (null on failure). */
  const persist = async (): Promise<number | null> => {
    const body = buildBody();
    if (!body) return null;
    try {
      if (alertId === null) {
        const created = await runtime.api.createAlert(body);
        setAlertId(created.id);
        return created.id;
      }
      await runtime.api.updateAlert(alertId, body);
      return alertId;
    } catch (error) {
      onError(`Could not save the alert: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const handleSave = async () => {
    if (busy) return;
    setBusy('save');
    const id = await persist();
    setBusy(null);
    if (id !== null) onClose();
  };

  // The backend tests SAVED alerts only: save (create-or-update) → test →
  // keep editing with the same id.
  const handleTest = async () => {
    if (busy) return;
    setBusy('test');
    setTestResult(null);
    const id = await persist();
    if (id !== null) {
      try {
        setTestResult(await runtime.api.testAlert(id));
      } catch (error) {
        onError(`Alert test failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    setBusy(null);
  };

  return (
    <RcdDialog
      title="Set alert"
      open={open}
      onClose={onClose}
      footer={
        <>
          <RcdButton disabled={!canSave || busy !== null} onClick={() => void handleTest()}>
            <FlaskConical size={14} />
            {busy === 'test' ? 'Testing…' : 'Test now'}
          </RcdButton>
          <RcdButton onClick={onClose} disabled={busy !== null}>
            Cancel
          </RcdButton>
          <RcdButton variant="primary" disabled={!canSave || busy !== null} onClick={() => void handleSave()}>
            {busy === 'save' ? 'Saving…' : alertId === null ? 'Create alert' : 'Save alert'}
          </RcdButton>
        </>
      }
    >
      {!source || measures.length === 0 ? (
        <p className="text-sm text-rcd-text-2">This chart has no measure to alert on.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Name
            <RcdInput value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <div className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Condition
            <div className="flex flex-wrap items-center gap-1.5">
              {measures.length > 1 ? (
                <RcdSelect
                  aria-label="Measure"
                  value={String(measureIndex)}
                  onChange={(event) => setMeasureIndex(Number(event.target.value))}
                  className="min-w-0 max-w-56"
                >
                  {measures.map((_, index) => (
                    <option key={index} value={String(index)}>
                      {measureLabel(source.chart, index)}
                    </option>
                  ))}
                </RcdSelect>
              ) : (
                <span className="text-sm text-rcd-text">{measureLabel(source.chart, 0)}</span>
              )}
              <RcdSelect
                aria-label="Operator"
                value={operator}
                onChange={(event) => setOperator(event.target.value as AlertOperator)}
              >
                {OPERATORS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </RcdSelect>
              <RcdInput
                type="number"
                aria-label="Threshold"
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
                className="w-28"
              />
            </div>
            <span className="text-xs text-rcd-muted">
              Evaluated over the chart&apos;s current filters (slicers, drill position, cross-filters).
            </span>
          </div>

          <label className="flex flex-col gap-1 text-sm text-rcd-text-2">
            Recipients
            <textarea
              value={recipientsText}
              onChange={(event) => setRecipientsText(event.target.value)}
              placeholder="one@example.com, two@example.com"
              rows={2}
              className="rounded-lg border border-rcd-border bg-rcd-surface px-3 py-1.5 text-sm text-rcd-text shadow-[var(--rcd-shadow-1)] outline-none transition-[border-color,box-shadow] placeholder:text-rcd-muted focus:border-[var(--rcd-accent-interactive)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--rcd-accent-interactive)_20%,transparent)]"
            />
            {invalidRecipients.length > 0 && (
              <span className="text-xs text-[var(--rcd-status-critical)]">
                These don&apos;t look like email addresses: {invalidRecipients.join(', ')}
              </span>
            )}
          </label>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-sm text-rcd-text-2">
              Check
              <RcdSelect
                value={String(everyMinutes)}
                onChange={(event) => setEveryMinutes(Number(event.target.value))}
              >
                {CADENCE_OPTIONS.map((minutes) => (
                  <option key={minutes} value={String(minutes)}>
                    every {minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}
                  </option>
                ))}
              </RcdSelect>
            </label>
            <label className="flex items-center gap-1.5 text-sm text-rcd-text-2">
              Cooldown
              <RcdSelect
                value={String(cooldownMinutes)}
                onChange={(event) => setCooldownMinutes(Number(event.target.value))}
              >
                {CADENCE_OPTIONS.map((minutes) => (
                  <option key={minutes} value={String(minutes)}>
                    {minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}
                  </option>
                ))}
              </RcdSelect>
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-sm text-rcd-text">
              <input
                type="checkbox"
                className="accent-[var(--rcd-accent)]"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Enabled
            </label>
          </div>

          {testResult && (
            <p
              className={`rounded-md border px-3 py-2 text-sm ${
                testResult.wouldFire
                  ? 'border-[var(--rcd-status-warn)] text-rcd-text'
                  : 'border-rcd-border text-rcd-text-2'
              }`}
            >
              Current value:{' '}
              <span className="font-medium">
                {testResult.value === null ? 'no data' : testResult.value.toLocaleString()}
              </span>{' '}
              — this alert {testResult.wouldFire ? 'WOULD fire' : 'would not fire'} right now.
            </p>
          )}
        </div>
      )}
    </RcdDialog>
  );
}
