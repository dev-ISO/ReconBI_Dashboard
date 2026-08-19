using Microsoft.Extensions.DependencyInjection;
using ReconDashboards.Core.Abstractions;

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
///
/// WAVE 2 (lock visibility): the three transitions collaborators can see —
/// fresh acquire, steal, explicit release — fire
/// <see cref="IRcdDashboardTileLockNotifier"/>; heartbeat extensions never do
/// (the interface doc carries the why). Firing lives HERE rather than in the
/// endpoint layer so every state change broadcasts no matter who drove it —
/// the ops endpoints today, a host's disconnect cleanup calling
/// <see cref="Release"/> directly tomorrow. Mechanics:
///  - fire-and-forget AFTER the state change, outside <see cref="_gate"/>
///    (the lock methods are synchronous; a broadcast must never extend the
///    critical section or fail the caller — best-effort by doctrine);
///  - notifier + <see cref="IUserDirectory"/> (holder display name) resolve
///    per fire through a fresh DI scope, NOT the singleton's constructor:
///    hosts may register either as SCOPED ("a later AddScoped wins" is the
///    documented directory contract) and a captive scoped dependency inside
///    this singleton would throw under scope validation. Same pattern as
///    SubscriptionDispatcher/SchedulingEvaluator.
///  - a null <paramref name="scopeFactory"/> (plain unit-test construction)
///    disables firing entirely — the wave-1 behavior.
/// </summary>
public sealed class DashboardTileLockService(
    TimeProvider timeProvider,
    IServiceScopeFactory? scopeFactory = null)
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
        bool announce;
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
            var heartbeat = existing is not null
                && string.Equals(existing.HolderUserId, userId, StringComparison.Ordinal)
                && existing.ExpiresAtUtc > now;
            current = new DashboardTileLock(
                dashboardId, tileId, userId, heartbeat ? existing!.AcquiredAtUtc : now, now + Ttl);
            _locks[key] = current;
            // Wave 2 visibility: fresh acquires and steals broadcast, heartbeat
            // extensions never do (see the class header). A SAME-holder
            // re-acquire after expiry counts as fresh — receivers aged the old
            // claim out at its TTL edge, so the chip needs re-establishing.
            announce = !heartbeat;
        }

        // Outside the gate: a broadcast must never extend the critical section.
        if (announce)
        {
            NotifyChanged(current, released: false);
        }

        return true;
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
        DashboardTileLock? removed = null;
        lock (_gate)
        {
            var key = (dashboardId, tileId);
            if (_locks.TryGetValue(key, out var existing)
                && string.Equals(existing.HolderUserId, userId, StringComparison.Ordinal))
            {
                _locks.Remove(key);
                removed = existing;
            }
        }

        if (removed is null)
        {
            return false;
        }

        // Wave 2 visibility: an explicit release clears collaborators' chips
        // immediately instead of letting them wait out the TTL. A release of
        // an already-expired own claim still fires — receivers dropped the
        // chip anyway, and the released event is idempotent by design.
        NotifyChanged(removed, released: true);
        return true;
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

    /// <summary>
    /// Fire-and-forget broadcast of one lock transition. Fire-and-forget is
    /// forced by the synchronous lock API and HONEST here: the state change
    /// already happened, the broadcast is best-effort visibility, and nothing
    /// can meaningfully await it. Everything inside is defensive — a resolver
    /// or notifier failure is swallowed (never observed as an unhandled task
    /// exception) because a lost chip update self-heals at the TTL edge.
    /// </summary>
    private void NotifyChanged(DashboardTileLock lockState, bool released)
    {
        if (scopeFactory is null)
        {
            return; // no host wiring (plain construction) — wave-1 behavior
        }

        _ = NotifyChangedAsync(lockState, released);
    }

    private async Task NotifyChangedAsync(DashboardTileLock lockState, bool released)
    {
        try
        {
            // Fresh scope per fire: the notifier and the directory may both be
            // host-registered SCOPED (see the class header) — resolving them
            // through this singleton's constructor would be a captive
            // dependency. The scope also gives the host bridge its usual
            // per-operation service graph (e.g. a scoped DbContext).
            using var scope = scopeFactory.CreateScope();
            var notifier = scope.ServiceProvider.GetService<IRcdDashboardTileLockNotifier>();
            if (notifier is null or NullRcdDashboardTileLockNotifier)
            {
                return; // no bridge — skip the directory lookup entirely
            }

            // Holder display name via the directory, raw id as the fallback —
            // the exact resolution the ops endpoint's 409 message uses.
            var displayName = lockState.HolderUserId;
            var directory = scope.ServiceProvider.GetService<IUserDirectory>();
            if (directory is not null)
            {
                var users = await directory.ResolveAsync([lockState.HolderUserId], CancellationToken.None);
                if (users.TryGetValue(lockState.HolderUserId, out var user))
                {
                    displayName = user.DisplayName;
                }
            }

            // CancellationToken.None on purpose: the triggering request may
            // already be complete/aborted; the broadcast rides its own life.
            await notifier.TileLockChangedAsync(
                new RcdTileLockChange(
                    lockState.DashboardId,
                    lockState.TileId,
                    lockState.HolderUserId,
                    displayName,
                    lockState.ExpiresAtUtc,
                    released),
                CancellationToken.None);
        }
        catch
        {
            // Best-effort by contract — a failed broadcast must never surface.
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
