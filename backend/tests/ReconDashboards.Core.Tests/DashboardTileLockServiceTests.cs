using Microsoft.Extensions.DependencyInjection;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Services;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Soft tile locks (COLLAB wave 1): TTL, heartbeat, steal-after-expiry, and
/// holder-checked release — all through a mutable clock, no real waiting.
/// Wave 2 adds the lock-change broadcast tests at the bottom (fires on fresh
/// acquire / steal / release, NEVER on a heartbeat extension).
/// </summary>
public class DashboardTileLockServiceTests
{
    private static readonly DateTimeOffset Start = new(2026, 8, 19, 12, 0, 0, TimeSpan.Zero);

    private readonly MutableTimeProvider _clock = new(Start);
    private readonly DashboardTileLockService _locks;

    public DashboardTileLockServiceTests()
    {
        _locks = new DashboardTileLockService(_clock);
    }

    [Fact]
    public void Acquire_GrantsTheLock_WithTtlExpiry()
    {
        Assert.True(_locks.TryAcquire(1, "t1", "alice", out var held));

        Assert.Equal("alice", held.HolderUserId);
        Assert.Equal(Start.UtcDateTime, held.AcquiredAtUtc);
        Assert.Equal(Start.UtcDateTime + DashboardTileLockService.Ttl, held.ExpiresAtUtc);
        Assert.Equal("alice", _locks.GetActive(1, "t1")!.HolderUserId);
    }

    [Fact]
    public void Heartbeat_ExtendsExpiry_ButKeepsAcquiredAt()
    {
        Assert.True(_locks.TryAcquire(1, "t1", "alice", out _));

        _clock.Advance(TimeSpan.FromSeconds(10));
        Assert.True(_locks.TryAcquire(1, "t1", "alice", out var beat));

        Assert.Equal(Start.UtcDateTime, beat.AcquiredAtUtc); // "editing since" survives heartbeats
        Assert.Equal(_clock.GetUtcNow().UtcDateTime + DashboardTileLockService.Ttl, beat.ExpiresAtUtc);
    }

    [Fact]
    public void SecondUser_IsBlockedWhileUnexpired_AndSeesTheHolder()
    {
        Assert.True(_locks.TryAcquire(1, "t1", "alice", out _));

        _clock.Advance(TimeSpan.FromSeconds(29));
        Assert.False(_locks.TryAcquire(1, "t1", "bob", out var current));

        Assert.Equal("alice", current.HolderUserId);
    }

    [Fact]
    public void ExpiredLock_IsStealable_WithFreshAcquiredAt()
    {
        Assert.True(_locks.TryAcquire(1, "t1", "alice", out _));

        _clock.Advance(DashboardTileLockService.Ttl + TimeSpan.FromSeconds(1));
        Assert.True(_locks.TryAcquire(1, "t1", "bob", out var stolen));

        Assert.Equal("bob", stolen.HolderUserId);
        Assert.Equal(_clock.GetUtcNow().UtcDateTime, stolen.AcquiredAtUtc);
    }

    [Fact]
    public void ExpiredLock_ReadsAsUnheld()
    {
        Assert.True(_locks.TryAcquire(1, "t1", "alice", out _));

        _clock.Advance(DashboardTileLockService.Ttl + TimeSpan.FromSeconds(1));

        Assert.Null(_locks.GetActive(1, "t1"));
        Assert.Empty(_locks.GetActiveForDashboard(1));
    }

    [Fact]
    public void Release_ByHolder_Frees_ByOthers_IsIgnored()
    {
        Assert.True(_locks.TryAcquire(1, "t1", "alice", out _));

        // A non-holder's release must never free someone else's claim.
        Assert.False(_locks.Release(1, "t1", "bob"));
        Assert.Equal("alice", _locks.GetActive(1, "t1")!.HolderUserId);

        Assert.True(_locks.Release(1, "t1", "alice"));
        Assert.Null(_locks.GetActive(1, "t1"));

        // Double release: idempotent.
        Assert.False(_locks.Release(1, "t1", "alice"));
    }

    [Fact]
    public void LocksAreScopedPerDashboardAndTile()
    {
        Assert.True(_locks.TryAcquire(1, "t1", "alice", out _));

        // Same tile id on ANOTHER dashboard, and another tile on the same
        // dashboard, are both free.
        Assert.True(_locks.TryAcquire(2, "t1", "bob", out _));
        Assert.True(_locks.TryAcquire(1, "t2", "bob", out _));

        var dashboard1 = _locks.GetActiveForDashboard(1);
        Assert.Equal(2, dashboard1.Count);
        Assert.DoesNotContain(dashboard1, l => l.DashboardId == 2);
    }

    /* ------------------------------------------- wave 2: change broadcasts
     * The service fires IRcdDashboardTileLockNotifier fire-and-forget from
     * its synchronous methods. These tests keep every async link in that
     * chain SYNCHRONOUSLY completing (Task.FromResult stubs), so the
     * notification has landed by the time the lock call returns and the
     * assertions never race the background task.
     */

    private static (DashboardTileLockService Locks, List<RcdTileLockChange> Changes) NotifyingLocks(
        MutableTimeProvider clock)
    {
        var changes = new List<RcdTileLockChange>();
        var services = new ServiceCollection();
        services.AddSingleton<IRcdDashboardTileLockNotifier>(new RecordingTileLockNotifier(changes));
        // Directory resolving "alice" only — proves both the resolved-name and
        // the raw-id-fallback paths in one fixture.
        services.AddSingleton<IUserDirectory>(new StubUserDirectory(
            new Dictionary<string, RcdUserInfo>(StringComparer.Ordinal)
            {
                ["alice"] = new("alice", "Alice A.", "alice@example.com"),
            }));
        var provider = services.BuildServiceProvider();
        return (
            new DashboardTileLockService(clock, provider.GetRequiredService<IServiceScopeFactory>()),
            changes);
    }

    [Fact]
    public void FreshAcquire_Broadcasts_WithResolvedDisplayName()
    {
        var (locks, changes) = NotifyingLocks(_clock);

        Assert.True(locks.TryAcquire(1, "t1", "alice", out var held));

        var change = Assert.Single(changes);
        Assert.Equal(1, change.DashboardId);
        Assert.Equal("t1", change.TileId);
        Assert.Equal("alice", change.HolderUserId);
        Assert.Equal("Alice A.", change.HolderDisplayName);
        Assert.Equal(held.ExpiresAtUtc, change.ExpiresAtUtc);
        Assert.False(change.Released);
    }

    [Fact]
    public void Heartbeat_NeverBroadcasts()
    {
        var (locks, changes) = NotifyingLocks(_clock);
        Assert.True(locks.TryAcquire(1, "t1", "alice", out _));

        // Two heartbeats inside the TTL: extensions are silent by design
        // (too chatty; receivers age the lock out by ExpiresAtUtc instead).
        _clock.Advance(TimeSpan.FromSeconds(10));
        Assert.True(locks.TryAcquire(1, "t1", "alice", out _));
        _clock.Advance(TimeSpan.FromSeconds(10));
        Assert.True(locks.TryAcquire(1, "t1", "alice", out _));

        Assert.Single(changes); // only the fresh acquire
    }

    [Fact]
    public void RejectedAcquire_DoesNotBroadcast()
    {
        var (locks, changes) = NotifyingLocks(_clock);
        Assert.True(locks.TryAcquire(1, "t1", "alice", out _));

        Assert.False(locks.TryAcquire(1, "t1", "bob", out _));

        Assert.Single(changes); // nothing changed → nothing to announce
    }

    [Fact]
    public void Steal_Broadcasts_TheNewHolder_WithRawIdFallback()
    {
        var (locks, changes) = NotifyingLocks(_clock);
        Assert.True(locks.TryAcquire(1, "t1", "alice", out _));

        _clock.Advance(DashboardTileLockService.Ttl + TimeSpan.FromSeconds(1));
        Assert.True(locks.TryAcquire(1, "t1", "bob", out var stolen));

        Assert.Equal(2, changes.Count);
        var change = changes[^1];
        Assert.Equal("bob", change.HolderUserId);
        Assert.Equal("bob", change.HolderDisplayName); // not in the directory → raw id
        Assert.Equal(stolen.ExpiresAtUtc, change.ExpiresAtUtc);
        Assert.False(change.Released);
    }

    [Fact]
    public void SameHolderReacquireAfterExpiry_BroadcastsLikeAFreshAcquire()
    {
        var (locks, changes) = NotifyingLocks(_clock);
        Assert.True(locks.TryAcquire(1, "t1", "alice", out _));

        // Receivers dropped the chip at the TTL edge — a post-expiry
        // re-acquire must re-establish it even for the same holder.
        _clock.Advance(DashboardTileLockService.Ttl + TimeSpan.FromSeconds(1));
        Assert.True(locks.TryAcquire(1, "t1", "alice", out _));

        Assert.Equal(2, changes.Count);
        Assert.False(changes[^1].Released);
    }

    [Fact]
    public void Release_Broadcasts_ReleasedTrue_OnlyWhenSomethingWasHeld()
    {
        var (locks, changes) = NotifyingLocks(_clock);
        Assert.True(locks.TryAcquire(1, "t1", "alice", out _));

        // Non-holder release: no state change → no broadcast.
        Assert.False(locks.Release(1, "t1", "bob"));
        Assert.Single(changes);

        Assert.True(locks.Release(1, "t1", "alice"));
        Assert.Equal(2, changes.Count);
        var change = changes[^1];
        Assert.Equal("t1", change.TileId);
        Assert.Equal("alice", change.HolderUserId);
        Assert.True(change.Released);

        // Double release: idempotent AND silent.
        Assert.False(locks.Release(1, "t1", "alice"));
        Assert.Equal(2, changes.Count);
    }

    [Fact]
    public void WithoutAScopeFactory_LockingWorks_AndNothingFires()
    {
        // The wave-1 construction shape (plain unit-test/new()) stays valid:
        // no scope factory simply means no broadcasts.
        var locks = new DashboardTileLockService(_clock);

        Assert.True(locks.TryAcquire(1, "t1", "alice", out _));
        Assert.True(locks.Release(1, "t1", "alice"));
    }

    private sealed class RecordingTileLockNotifier(List<RcdTileLockChange> changes)
        : IRcdDashboardTileLockNotifier
    {
        public Task TileLockChangedAsync(RcdTileLockChange change, CancellationToken ct)
        {
            changes.Add(change);
            return Task.CompletedTask;
        }
    }

    private sealed class StubUserDirectory(IReadOnlyDictionary<string, RcdUserInfo> users)
        : IUserDirectory
    {
        public Task<IReadOnlyList<RcdUserInfo>> ListUsersAsync(string? query, CancellationToken ct) =>
            Task.FromResult<IReadOnlyList<RcdUserInfo>>([.. users.Values]);

        public Task<IReadOnlyDictionary<string, RcdUserInfo>> ResolveAsync(
            IEnumerable<string> userIds, CancellationToken ct)
        {
            var resolved = userIds
                .Where(users.ContainsKey)
                .Distinct(StringComparer.Ordinal)
                .ToDictionary(id => id, id => users[id], StringComparer.Ordinal);
            return Task.FromResult<IReadOnlyDictionary<string, RcdUserInfo>>(resolved);
        }
    }

    private sealed class MutableTimeProvider(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset _now = start;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan by) => _now += by;
    }
}
