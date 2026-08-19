namespace ReconDashboards.Core.Abstractions;

/// <summary>
/// One committed collaborative-dashboard edit op (COLLAB-DESIGN wave 1). Fired
/// AFTER the ops endpoint's transaction commits, so receivers can never observe
/// an op whose write was rolled back. The host adapter forwards it verbatim to
/// the dashboard's realtime group (the tracker's RcdDashboardOpEventDto pins
/// the wire shape: same fields, with ActorUserId mapped to the host's numeric
/// user id and ResultUpdatedAtUtc serialized as an ISO-8601 "o" string).
/// </summary>
/// <param name="DashboardId">The dashboard the op was applied to.</param>
/// <param name="OpId">Client-generated unique id — receiving clients use it to
/// drop the echo of their own op instead of double-applying it.</param>
/// <param name="ActorUserId">Opaque host user id of the editor (the library's
/// user-id convention — hosts translate, same as IRcdDispatchProgressNotifier's
/// OwnerUserId).</param>
/// <param name="Class">The op's dominant permission class as the server
/// classified it: "layout" | "pages" | "charts" | "geometry" | "removal".
/// Informational for receivers (attribution/telemetry) — authorization already
/// happened against the FULL class set before this event exists.</param>
/// <param name="TargetKind">"tile" | "page" | "doc".</param>
/// <param name="TargetId">Id of the targeted doc element; null for doc-scoped
/// ops (pageReorder, docSettingSet).</param>
/// <param name="PayloadJson">The op body exactly as submitted (kind + fields).
/// Receiving clients re-apply it through their mutation seams; the host never
/// interprets it.</param>
/// <param name="ResultUpdatedAtUtc">The dashboard's UpdatedAtUtc AFTER this op
/// was applied — receivers advance their concurrency baseline to it.</param>
public sealed record RcdDashboardOp(
    int DashboardId,
    string OpId,
    string ActorUserId,
    string Class,
    string TargetKind,
    string? TargetId,
    string PayloadJson,
    DateTime ResultUpdatedAtUtc);

/// <summary>
/// Host seam for LIVE op broadcast. The library cannot own a socket, so the
/// host (e.g. the tracker's SignalR EventsHub) forwards each committed op to
/// the dashboard-{id} group; frontends without a host bridge simply stay on
/// refetch-based reconciliation. Same seam pattern as
/// <see cref="IRcdDispatchProgressNotifier"/>: the library registers the no-op
/// default with TryAdd, a host registration after AddReconDashboards wins.
/// Implementations MUST be best-effort — called after the op already
/// committed, so throwing would fail a succeeded request; catch and log inside.
/// </summary>
public interface IRcdDashboardOpNotifier
{
    Task OpAppliedAsync(RcdDashboardOp op, CancellationToken ct);
}

/// <summary>Default when the host wires no realtime channel: collaborators reconcile by refetch only.</summary>
public sealed class NullRcdDashboardOpNotifier : IRcdDashboardOpNotifier
{
    public Task OpAppliedAsync(RcdDashboardOp op, CancellationToken ct) => Task.CompletedTask;
}
