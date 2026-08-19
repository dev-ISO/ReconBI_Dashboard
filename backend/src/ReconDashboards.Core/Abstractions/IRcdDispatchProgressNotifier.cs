namespace ReconDashboards.Core.Abstractions;

/// <summary>
/// A dispatch began: the manager UI opens its live progress strip on this.
/// Recipient count includes opted-out addresses (they resolve instantly).
/// </summary>
public sealed record RcdDispatchStarted(
    string OwnerUserId,
    long DispatchId,
    int SubscriptionId,
    string SubscriptionName,
    string Trigger,
    int RecipientCount,
    DateTime StartedUtc);

/// <summary>
/// One recipient reached a state worth painting: "sent", "failed",
/// "optedOut", or "pending" (a failed attempt that will retry — Attempts
/// tells the strip which attempt just finished).
/// </summary>
public sealed record RcdDispatchRecipientResult(
    string OwnerUserId,
    long DispatchId,
    int SubscriptionId,
    string Email,
    string Status,
    int Attempts,
    string? Error);

/// <summary>
/// The dispatch closed with its roll-up status ("sent" | "partial" |
/// "failed" | "skipped") and final per-status counts.
/// </summary>
public sealed record RcdDispatchFinished(
    string OwnerUserId,
    long DispatchId,
    int SubscriptionId,
    string Status,
    int SentCount,
    int FailedCount,
    int OptedOutCount,
    string? Error,
    DateTime FinishedUtc);

/// <summary>
/// Host seam for LIVE send-progress. The library cannot own a socket, so the
/// host (e.g. the tracker's SignalR EventsHub) forwards these to the
/// subscription OWNER's user id; frontends without a host bridge fall back to
/// polling the dispatch-history endpoint. Same seam pattern as
/// <see cref="IUserDirectory"/>: the library registers the no-op default with
/// TryAdd, a host registration after AddReconDashboardsScheduling wins.
/// Implementations MUST be best-effort — resolved per dispatch scope, called
/// on the scheduler's hot path; throwing is logged and never fails a send.
/// </summary>
public interface IRcdDispatchProgressNotifier
{
    Task DispatchStartedAsync(RcdDispatchStarted started, CancellationToken ct);

    Task RecipientResultAsync(RcdDispatchRecipientResult result, CancellationToken ct);

    Task DispatchFinishedAsync(RcdDispatchFinished finished, CancellationToken ct);
}

/// <summary>Default when the host wires no realtime channel: progress is poll-only.</summary>
public sealed class NullRcdDispatchProgressNotifier : IRcdDispatchProgressNotifier
{
    public Task DispatchStartedAsync(RcdDispatchStarted started, CancellationToken ct) => Task.CompletedTask;

    public Task RecipientResultAsync(RcdDispatchRecipientResult result, CancellationToken ct) => Task.CompletedTask;

    public Task DispatchFinishedAsync(RcdDispatchFinished finished, CancellationToken ct) => Task.CompletedTask;
}
