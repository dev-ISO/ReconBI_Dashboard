using ReconDashboards.Core.Services;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Soft tile locks (COLLAB wave 1): TTL, heartbeat, steal-after-expiry, and
/// holder-checked release — all through a mutable clock, no real waiting.
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

    private sealed class MutableTimeProvider(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset _now = start;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan by) => _now += by;
    }
}
