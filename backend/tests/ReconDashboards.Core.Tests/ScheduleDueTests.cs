using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Pure UTC due-logic tests for subscription schedules (interval / daily /
/// weekly) and alert cadence/cooldown. All math is plain UTC, so DST
/// transitions cannot shift anything — one test crosses a US DST boundary to
/// pin that down.
/// </summary>
public class ScheduleDueTests
{
    private static SubscriptionRecord Interval(int minutes, DateTime? lastRun, DateTime? created = null) => new()
    {
        Enabled = true,
        ScheduleKind = SubscriptionScheduleKind.Interval,
        IntervalMinutes = minutes,
        LastRunUtc = lastRun,
        CreatedUtc = created ?? new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
    };

    private static SubscriptionRecord Daily(int minutesOfDay, DateTime created, DateTime? lastRun = null) => new()
    {
        Enabled = true,
        ScheduleKind = SubscriptionScheduleKind.Daily,
        TimeOfDayMinutesUtc = minutesOfDay,
        CreatedUtc = created,
        LastRunUtc = lastRun,
    };

    private static SubscriptionRecord Weekly(int day, int minutesOfDay, DateTime created, DateTime? lastRun = null) => new()
    {
        Enabled = true,
        ScheduleKind = SubscriptionScheduleKind.Weekly,
        DayOfWeekUtc = day,
        TimeOfDayMinutesUtc = minutesOfDay,
        CreatedUtc = created,
        LastRunUtc = lastRun,
    };

    private static DateTime Utc(int year, int month, int day, int hour = 0, int minute = 0) =>
        new(year, month, day, hour, minute, 0, DateTimeKind.Utc);

    // ---------- interval ----------

    [Fact]
    public void IntervalNeverRunIsDueImmediately() =>
        Assert.True(ScheduleDue.IsDue(Interval(30, lastRun: null), Utc(2026, 8, 5, 12, 0)));

    [Fact]
    public void IntervalNotDueBeforeElapsed() =>
        Assert.False(ScheduleDue.IsDue(Interval(30, Utc(2026, 8, 5, 11, 45)), Utc(2026, 8, 5, 12, 0)));

    [Fact]
    public void IntervalDueExactlyAtElapsed() =>
        Assert.True(ScheduleDue.IsDue(Interval(30, Utc(2026, 8, 5, 11, 30)), Utc(2026, 8, 5, 12, 0)));

    [Fact]
    public void DisabledSubscriptionIsNeverDue()
    {
        var subscription = Interval(5, lastRun: null);
        subscription.Enabled = false;
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 12, 0)));
    }

    // ---------- daily ----------

    [Fact]
    public void DailyDueOncePastScheduledTime()
    {
        var subscription = Daily(9 * 60, created: Utc(2026, 8, 4, 15, 0)); // created yesterday afternoon
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 8, 59)));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 9, 0)));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 23, 59)));
    }

    [Fact]
    public void DailyDoesNotFireTwiceForTheSameDay()
    {
        var subscription = Daily(9 * 60, created: Utc(2026, 8, 1), lastRun: Utc(2026, 8, 5, 9, 1));
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 12, 0)));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 6, 9, 0))); // next day fires again
    }

    [Fact]
    public void DailyCreatedAfterTodaysSlotWaitsForTomorrow()
    {
        var subscription = Daily(9 * 60, created: Utc(2026, 8, 5, 10, 30));
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 11, 0)));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 6, 9, 0)));
    }

    [Fact]
    public void DailyMissedSlotStillFiresLate()
    {
        // Host was down at 09:00; the 14:23 tick still delivers today's run.
        var subscription = Daily(9 * 60, created: Utc(2026, 8, 1), lastRun: Utc(2026, 8, 4, 9, 0));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 14, 23)));
    }

    [Fact]
    public void DailyIsDstAgnostic()
    {
        // US DST starts 2026-03-08; a 02:30 UTC schedule is pure UTC math and
        // fires exactly once on both sides of the transition.
        var subscription = Daily(150, created: Utc(2026, 3, 6), lastRun: Utc(2026, 3, 7, 2, 30));
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 3, 7, 23, 59)));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 3, 8, 2, 30)));

        subscription.LastRunUtc = Utc(2026, 3, 8, 2, 30);
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 3, 8, 23, 59)));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 3, 9, 2, 30)));
    }

    // ---------- weekly ----------

    [Fact]
    public void WeeklyDueOnScheduledDayAndTime()
    {
        // 2026-08-05 is a Wednesday (day 3); last run was last week's slot.
        var subscription = Weekly(3, 8 * 60, created: Utc(2026, 7, 1), lastRun: Utc(2026, 7, 29, 8, 0));
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 7, 59)));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 8, 0)));
    }

    [Fact]
    public void WeeklyDoesNotRefireUntilNextWeek()
    {
        var subscription = Weekly(3, 8 * 60, created: Utc(2026, 7, 1), lastRun: Utc(2026, 8, 5, 8, 2));
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 8, 6, 8, 0))); // Thursday
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 8, 11, 8, 0))); // Tuesday next week
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 12, 8, 0))); // Wednesday next week
    }

    [Fact]
    public void WeeklyMissedSlotFiresLaterInTheWeek()
    {
        var subscription = Weekly(3, 8 * 60, created: Utc(2026, 7, 1), lastRun: Utc(2026, 7, 29, 8, 0));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 7, 16, 40))); // Friday, missed Wednesday
    }

    [Fact]
    public void WeeklyCreatedAfterThisWeeksSlotWaitsForNextWeek()
    {
        var subscription = Weekly(3, 8 * 60, created: Utc(2026, 8, 5, 12, 0)); // Wednesday noon
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 8, 6, 8, 0)));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 12, 8, 0)));
    }

    [Fact]
    public void MalformedScheduleIsNeverDue()
    {
        var noTime = Daily(0, created: Utc(2026, 8, 1));
        noTime.TimeOfDayMinutesUtc = null;
        Assert.False(ScheduleDue.IsDue(noTime, Utc(2026, 8, 5, 12, 0)));

        var badDay = Weekly(9, 8 * 60, created: Utc(2026, 7, 1));
        Assert.False(ScheduleDue.IsDue(badDay, Utc(2026, 8, 5, 12, 0)));
    }

    // ---------- alerts ----------

    private static AlertRecord Alert(
        int everyMinutes, int cooldownMinutes, DateTime? evaluated = null, DateTime? fired = null, bool enabled = true) =>
        new()
        {
            Enabled = enabled,
            EveryMinutes = everyMinutes,
            CooldownMinutes = cooldownMinutes,
            LastEvaluatedUtc = evaluated,
            LastFiredUtc = fired,
        };

    [Fact]
    public void AlertNeverEvaluatedIsDue() =>
        Assert.True(ScheduleDue.IsAlertDue(Alert(5, 0), Utc(2026, 8, 5, 12, 0)));

    [Fact]
    public void AlertNotDueWithinCadence() =>
        Assert.False(ScheduleDue.IsAlertDue(Alert(5, 0, evaluated: Utc(2026, 8, 5, 11, 58)), Utc(2026, 8, 5, 12, 0)));

    [Fact]
    public void DisabledAlertIsNeverDue() =>
        Assert.False(ScheduleDue.IsAlertDue(Alert(5, 0, enabled: false), Utc(2026, 8, 5, 12, 0)));

    [Fact]
    public void CooldownSuppressesUntilElapsed()
    {
        var alert = Alert(5, 60, fired: Utc(2026, 8, 5, 11, 30));
        Assert.False(ScheduleDue.CooldownElapsed(alert, Utc(2026, 8, 5, 12, 0)));
        Assert.True(ScheduleDue.CooldownElapsed(alert, Utc(2026, 8, 5, 12, 30)));
    }

    [Theory]
    [InlineData(AlertOperator.Gt, 301, 300, true)]
    [InlineData(AlertOperator.Gt, 300, 300, false)]
    [InlineData(AlertOperator.Gte, 300, 300, true)]
    [InlineData(AlertOperator.Lt, 299, 300, true)]
    [InlineData(AlertOperator.Lte, 300, 300, true)]
    [InlineData(AlertOperator.Lte, 301, 300, false)]
    [InlineData(AlertOperator.Eq, 300, 300, true)]
    [InlineData(AlertOperator.Eq, 299, 300, false)]
    public void ConditionMetMatchesOperator(AlertOperator op, int value, int threshold, bool expected) =>
        Assert.Equal(expected, ScheduleDue.ConditionMet(op, value, threshold));
}
