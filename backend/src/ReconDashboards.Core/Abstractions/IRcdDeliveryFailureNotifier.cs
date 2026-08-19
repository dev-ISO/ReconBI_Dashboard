namespace ReconDashboards.Core.Abstractions;

/// <summary>
/// A dispatch closed "failed" or "partial". FirstError is the first
/// per-recipient error (or the occurrence-level error for render failures) —
/// enough for a self-contained notification without another query.
/// </summary>
public sealed record RcdDispatchFailure(
    string OwnerUserId,
    long DispatchId,
    int SubscriptionId,
    string SubscriptionName,
    int DashboardId,
    string Status,
    int SentCount,
    int FailedCount,
    string? FirstError,
    DateTime FinishedUtc);

/// <summary>
/// Host seam for surfacing delivery failures where the OWNER actually looks
/// (e.g. the tracker writes a notification-bell row). Fired once per dispatch
/// that closes failed/partial — never for sent/skipped. Same TryAdd-default /
/// host-overrides pattern as <see cref="IRcdDispatchProgressNotifier"/>;
/// implementations must be best-effort (exceptions are logged, the dispatch
/// outcome is already recorded either way).
/// </summary>
public interface IRcdDeliveryFailureNotifier
{
    Task DispatchFailedAsync(RcdDispatchFailure failure, CancellationToken ct);
}

/// <summary>Default when the host surfaces failures nowhere beyond the history drawer.</summary>
public sealed class NullRcdDeliveryFailureNotifier : IRcdDeliveryFailureNotifier
{
    public Task DispatchFailedAsync(RcdDispatchFailure failure, CancellationToken ct) => Task.CompletedTask;
}
