/**
 * Actionable text for chart-query failures, keyed by the server's
 * `rcd.query.*` error codes (QRY_* compilation codes through
 * ChartQueryService.ToErrorCode). The core fetcher's FRIENDLY_ERROR_TEXT
 * covers dashboard/model codes only; the query family is mapped here where
 * the error card renders. Unmapped codes fall back to the raw server message.
 */

export interface QueryErrorText {
  /** What went wrong, in the user's terms. */
  message: string;
  /** Optional "what to do about it" line rendered under the message. */
  hint?: string;
}

const QUERY_ERROR_TEXT: Record<string, QueryErrorText> = {
  'rcd.query.disconnected': {
    message: 'This chart uses tables that are not connected in the model.',
    hint: 'Add a relationship between them on the model canvas.',
  },
  'rcd.query.ambiguous_path': {
    message: 'The tables in this chart can be joined in more than one way.',
    hint: 'On the model canvas, keep one relationship path active between them.',
  },
  'rcd.query.unknown_table': {
    message: 'A table this chart uses is no longer in the model.',
    hint: 'Edit the chart’s fields, or re-add the table to the model.',
  },
  'rcd.query.unknown_column': {
    message: 'A column this chart uses no longer exists in the model.',
    hint: 'Edit the chart’s fields to remove or replace it.',
  },
  'rcd.query.unknown_measure': {
    message: 'A measure this chart uses was removed from the model.',
    hint: 'Edit the chart’s fields and pick another measure.',
  },
  'rcd.query.bad_measure': {
    message: 'A measure in this chart does not fit its column (aggregation/type mismatch).',
    hint: 'Edit the chart’s fields and pick a different aggregation or column.',
  },
  'rcd.query.bad_bucket': {
    message: 'A date grouping in this chart is applied to a non-date column.',
    hint: 'Edit the chart’s fields and remove the date bucket.',
  },
  'rcd.query.bad_column': {
    message: 'A column in this chart has a type that cannot be queried.',
    hint: 'Edit the chart’s fields to remove or replace it.',
  },
  'rcd.query.bad_sort': {
    message: 'This chart’s sort points at a field that is no longer there.',
    hint: 'Edit the chart and reset its sort.',
  },
  'rcd.query.model_drift': {
    message: 'The model no longer matches the database. Open the model editor to repair it.',
  },
  'rcd.query.execution_failed': {
    message: 'The database could not run this chart’s query.',
    hint: 'Retry may succeed; if it keeps failing, check the chart’s fields and filters.',
  },
  'rcd.query.denied_by_scope': {
    message: 'Your access does not allow querying this data.',
  },
};

/** All `rcd.query.too_many_*` limits share one message. */
const TOO_MANY_PREFIX = 'rcd.query.too_many_';

const TOO_MANY_TEXT: QueryErrorText = {
  message: 'This chart asks for more fields or filters than one query allows.',
  hint: 'Remove some fields, filters, or drill levels from the chart.',
};

/** Rate-limited (HTTP 429) responses carry no error code — match the status line. */
const RATE_LIMIT_TEXT: QueryErrorText = {
  message: 'Too many chart queries at once — retrying may succeed.',
};

/**
 * Friendly text for a query-cache error entry: the errorCode's mapped text, a
 * 429 status-line match, or the raw server message as-is (server messages are
 * contract-specified and usually already precise).
 */
export const queryErrorTextFor = (
  errorCode: string | null | undefined,
  rawMessage: string,
): QueryErrorText => {
  if (errorCode) {
    const mapped = QUERY_ERROR_TEXT[errorCode];
    if (mapped) return mapped;
    if (errorCode.startsWith(TOO_MANY_PREFIX)) return TOO_MANY_TEXT;
  }
  if (/^429\b/.test(rawMessage)) return RATE_LIMIT_TEXT;
  return { message: rawMessage };
};
