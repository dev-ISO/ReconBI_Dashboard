namespace ReconDashboards.Core.Abstractions;

/// <summary>
/// One soft tile-lock transition worth telling collaborators about
/// (COLLAB-DESIGN wave 2 — "lock visibility"). Fired by
/// <see cref="Services.DashboardTileLockService"/> AFTER its in-memory state
/// changed, for exactly three transitions: a FRESH acquire, a STEAL of an
/// expired claim, and an explicit RELEASE. Heartbeat extensions deliberately
/// never fire — at a 20 s client heartbeat per locked tile they would dwarf
/// every other realtime channel, and receivers already age locks out by
/// <paramref name="ExpiresAtUtc"/>, so a silent extension merely lets a chip
/// fade a little early rather than showing anything wrong.
/// </summary>
/// <param name="DashboardId">Dashboard the locked tile belongs to.</param>
/// <param name="TileId">The locked tile.</param>
/// <param name="HolderUserId">Opaque host user id of the lock holder (the
/// library's user-id convention — hosts translate to their own id space when
/// broadcasting, same as <see cref="RcdDashboardOp.ActorUserId"/>).</param>
/// <param name="HolderDisplayName">Holder's directory display name, resolved
/// best-effort through <see cref="IUserDirectory"/>; falls back to the raw id
/// (the NullUserDirectory convention) so receivers can always label the chip.</param>
/// <param name="ExpiresAtUtc">The claim's TTL edge as of this transition —
/// receivers drop the lock locally once it passes (their substitute for the
/// heartbeat events that never come). For a release this is the released
/// claim's old edge; Released=true removes the lock immediately regardless.</param>
/// <param name="Released">True when the holder explicitly released the tile
/// (builder close / drag end / session exit) — receivers clear the lock now
/// instead of waiting out the TTL.</param>
public sealed record RcdTileLockChange(
    int DashboardId,
    string TileId,
    string HolderUserId,
    string HolderDisplayName,
    DateTime ExpiresAtUtc,
    bool Released);

/// <summary>
/// Host seam for LIVE tile-lock visibility. The library cannot own a socket,
/// so the host (e.g. the tracker's SignalR EventsHub) forwards each change to
/// the dashboard-{id} group; frontends without a host bridge simply keep
/// wave 1's invisible locks (holds + 409s still work — visibility is polish,
/// not correctness). Same seam pattern as <see cref="IRcdDashboardOpNotifier"/>:
/// the library registers the no-op default with TryAdd, a host registration
/// after AddReconDashboards wins. Implementations MUST be best-effort — the
/// lock state already changed when this fires, so throwing could fail a
/// request that succeeded; catch and log inside (the service additionally
/// swallows, since it fires fire-and-forget from synchronous lock methods).
/// </summary>
public interface IRcdDashboardTileLockNotifier
{
    Task TileLockChangedAsync(RcdTileLockChange change, CancellationToken ct);
}

/// <summary>Default when the host wires no realtime channel: lock visibility stays client-local (wave 1 behavior).</summary>
public sealed class NullRcdDashboardTileLockNotifier : IRcdDashboardTileLockNotifier
{
    public Task TileLockChangedAsync(RcdTileLockChange change, CancellationToken ct) => Task.CompletedTask;
}
