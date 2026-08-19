import { useEffect, useState } from 'react';
import type { SubscriptionContentConfig, SubscriptionPreviewResult } from '@recon/dashboards-core';
import { rcdErrorMessage } from '@recon/dashboards-core';
import { useRuntime } from '../provider/DashboardsProvider';
import { RcdButton, RcdDialog, RcdSpinner } from '../primitives';

/**
 * What to preview. 'saved' posts subscriptions/{id}/preview — an ABSENT
 * `content` sends {} (the saved config renders as-is); a present one, null
 * included, rides as an override for this render only. 'draft' posts
 * dashboards/{id}/subscriptions/preview for a subscription that does not
 * exist yet (owner = caller). `format` only drives the "+ CSV attachment"
 * note — the saved endpoint always renders the html body.
 */
export type SubscriptionPreviewRequest =
  | {
      kind: 'saved';
      subscriptionId: number;
      format: 'html' | 'csv';
      content?: SubscriptionContentConfig | null;
    }
  | {
      kind: 'draft';
      dashboardId: number;
      format: 'html' | 'csv';
      content: SubscriptionContentConfig | null;
    };

/**
 * "Email preview" dialog shared by the subscription form (current draft) and
 * the Subscriptions & alerts manager (saved config): subject line as text and
 * the composed body in a FULLY sandboxed iframe — sandbox="" so the email
 * HTML (which embeds data: chart images) can never run script, navigate, or
 * reach this origin.
 */
export function SubscriptionPreviewDialog({
  request,
  onClose,
}: {
  /** null = closed. Callers keep the request in state — a fresh object per render would re-fetch forever. */
  request: SubscriptionPreviewRequest | null;
  onClose: () => void;
}) {
  const runtime = useRuntime();
  const [result, setResult] = useState<SubscriptionPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
    if (request === null) return;
    let cancelled = false;
    const load =
      request.kind === 'saved'
        ? runtime.api.previewSubscription(
            request.subscriptionId,
            request.content === undefined ? {} : { content: request.content },
          )
        : runtime.api.previewDraftSubscription(request.dashboardId, {
            format: request.format,
            content: request.content,
          });
    load
      .then((preview) => {
        if (!cancelled) setResult(preview);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(rcdErrorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, request]);

  return (
    <RcdDialog
      title="Email preview"
      open={request !== null}
      onClose={onClose}
      wide
      footer={<RcdButton onClick={onClose}>Close</RcdButton>}
    >
      {error !== null ? (
        <p className="text-sm text-[var(--rcd-status-critical)]">
          Could not build the preview: {error}
        </p>
      ) : result === null ? (
        <div className="flex h-24 items-center justify-center">
          <RcdSpinner label="Building preview…" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-rcd-text">
            <span className="font-medium">Subject:</span> {result.subject}
          </p>
          {/* bg-white: emails are composed on light paper regardless of app theme. */}
          <iframe
            title="Email body preview"
            sandbox=""
            srcDoc={result.html}
            className="h-[70vh] w-full rounded-md border border-rcd-border bg-white"
          />
          <p className="text-xs text-rcd-muted">
            Approximate preview — email clients may render differently.
            {request?.format === 'csv' ? ' + CSV attachment' : ''}
          </p>
        </div>
      )}
    </RcdDialog>
  );
}
