namespace ReconDashboards.Core.Services;

/// <summary>One live soft claim on (dashboard, tile): who holds it and until when.</summary>
public sealed record DashboardTileLock(
    int DashboardId,
    string TileId,
    string HolderUserId,
    DateTime AcquiredAtUtc,
    DateTime ExpiresAtUtc);

/// <summary>
/// Soft tile locks for collaborative editing (COLLAB-DESIGN wave 1): a
/// (dashboardId, tileId) → holder map with a heartbeat TTL, cloned in spirit
/// from the tracker's GridPresenceTracker. Locks ADVISE, they do not enforce
/// ownership of data: the ops endpoint rejects a non-holder's op on a locked
/// tile (rcd.dashboard.tile_locked) so the chart builder never saves over a
/// tile someone else is actively editing — but an expired lock is simply
/// stealable, and nothing here survives a restart.
///
/// Deliberately IN-MEMORY, process-local state (registered as a singleton):
/// the design's accepted single-instance constraint (no SignalR backplane)
/// already pins collaboration to one process, so a shared lock store would
/// add a dependency without adding correctness. Scale-out would move this to
/// Redis together with the backplane.
///
/// Expiry is lazy — an expired entry acts unheld on every read and is pruned
/// when touched (plus a periodic full sweep amortized over acquires) rather
/// than by a timer, which keeps the service trivially testable through
/// <see cref="TimeProvider"/>.
/// </summary>
public sealed class DashboardTileLockService(TimeProvider timeProvider)
{
    /// <summary>
    /// Lock lifetime per heartbeat. ~30 s per the design contract: long enough
    /// that a 10–15 s client heartbeat survives a missed beat, short enough
    /// that a crashed editor frees the tile before a collaborator gives up.
    /// </summary>
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(30);

    /// <summary>Full-sweep cadence: every N acquires, drop every expired entry map-wide.</summary>
    private const int SweepEvery = 256;

    private readonly Dictionary<(int DashboardId, string TileId), DashboardTileLock> _locks = [];
    private readonly Lock _gate = new();
    private int _acquiresSinceSweep;

    /// <summary>
    /// Acquires the lock, heartbeats it (same holder → TTL extended), or steals
    /// an expired one. Returns true when <paramref name="userId"/> holds the
    /// lock afterwards; false when another user's UNEXPIRED claim stands —
    /// <paramref name="current"/> then carries that claim so callers can name
    /// the holder in the rejection.
    /// </summary>
    public bool TryAcquire(int dashboardId, string tileId, string userId, out DashboardTileLock current)
    {
        var now = timeProvider.GetUtcNow().UtcDateTime;
        lock (_gate)
        {
            SweepIfDue(now);

            var key = (dashboardId, tileId);
            if (_locks.TryGetValue(key, out var existing)
                && existing.ExpiresAtUtc > now
                && !string.Equals(existing.HolderUserId, userId, StringComparison.Ordinal))
            {
                current = existing;
                return false;
            }

            // Fresh acquire, heartbeat, or steal-after-expiry all land here.
            // AcquiredAtUtc is preserved across heartbeats so "editing since"
            // stays honest when wave 2 renders locks.
            var acquiredAt = existing is not null
                && string.Equals(existing.HolderUserId, userId, StringComparison.Ordinal)
                && existing.ExpiresAtUtc > now
                    ? existing.AcquiredAtUtc
                    : now;
            current = new DashboardTileLock(dashboardId, tileId, userId, acquiredAt, now + Ttl);
            _locks[key] = current;
            return true;
        }
    }

    /// <summary>
    /// Releases the caller's lock. Idempotent and holder-checked: releasing a
    /// tile you do not hold (already expired and stolen, double release) is a
    /// no-op rather than an error — the client is telling us it stopped
    /// editing, which is never wrong to accept. Returns true when an entry
    /// held by <paramref name="userId"/> was actually removed.
    /// </summary>
    public bool Release(int dashboardId, string tileId, string userId)
    {
        lock (_gate)
        {
            var key = (dashboardId, tileId);
            if (_locks.TryGetValue(key, out var existing)
                && string.Equals(existing.HolderUserId, userId, StringComparison.Ordinal))
            {
                _locks.Remove(key);
                return true;
            }

            return false;
        }
    }

    /// <summary>The unexpired claim on one tile, or null. Prunes an expired entry it finds.</summary>
    public DashboardTileLock? GetActive(int dashboardId, string tileId)
    {
        var now = timeProvider.GetUtcNow().UtcDateTime;
        lock (_gate)
        {
            var key = (dashboardId, tileId);
            if (!_locks.TryGetValue(key, out var existing))
            {
                return null;
            }

            if (existing.ExpiresAtUtc <= now)
            {
                _locks.Remove(key);
                return null;
            }

            return existing;
        }
    }

    /// <summary>All unexpired claims on one dashboard (wave 2's lock rendering reads this).</summary>
    public IReadOnlyList<DashboardTileLock> GetActiveForDashboard(int dashboardId)
    {
        var now = timeProvider.GetUtcNow().UtcDateTime;
        lock (_gate)
        {
            return _locks.Values
                .Where(l => l.DashboardId == dashboardId && l.ExpiresAtUtc > now)
                .OrderBy(l => l.AcquiredAtUtc)
                .ToList();
        }
    }

    /// <summary>Must be called under <see cref="_gate"/>.</summary>
    private void SweepIfDue(DateTime now)
    {
        if (++_acquiresSinceSweep < SweepEvery)
        {
            return;
        }

        _acquiresSinceSweep = 0;
        foreach (var key in _locks.Where(kv => kv.Value.ExpiresAtUtc <= now).Select(kv => kv.Key).ToList())
        {
            _locks.Remove(key);
        }
    }
}
