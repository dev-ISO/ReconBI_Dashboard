using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Due-logic tests for subscription schedules (interval / daily / weekly) and
/// alert cadence/cooldown. Daily/weekly occurrences are wall-clock times in a
/// configurable schedule zone; the bulk of the suite runs through IsDueUtc
/// (zone = UTC), which must behave exactly like the original pure-UTC math.
/// The schedule-zone section below covers America/Chicago: offset shifts,
/// weekly day resolution on the local calendar, and both DST edges
/// (spring-forward gap advances by the gap; fall-back ambiguity maps to
/// STANDARD time — the second occurrence — so each day sends exactly once).
/// </summary>
public class ScheduleDueTests
{
    private static readonly TimeZoneInfo UtcZone = TimeZoneInfo.Utc;

    /// <summary>US central time: CST (UTC-6) / CDT (UTC-5). In 2026 DST runs
    /// 2026-03-08 02:00 local through 2026-11-01 02:00 local.</summary>
    private static readonly TimeZoneInfo Chicago = TimeZoneInfo.FindSystemTimeZoneById("America/Chicago");

    /// <summary>Zone=UTC evaluation — the legacy behavior the pre-zone tests pin.</summary>
    private static bool IsDueUtc(SubscriptionRecord subscription, DateTime nowUtc) =>
        ScheduleDue.IsDue(subscription, nowUtc, UtcZone);

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
        Assert.True(IsDueUtc(Interval(30, lastRun: null), Utc(2026, 8, 5, 12, 0)));

    [Fact]
    public void IntervalNotDueBeforeElapsed() =>
        Assert.False(IsDueUtc(Interval(30, Utc(2026, 8, 5, 11, 45)), Utc(2026, 8, 5, 12, 0)));

    [Fact]
    public void IntervalDueExactlyAtElapsed() =>
        Assert.True(IsDueUtc(Interval(30, Utc(2026, 8, 5, 11, 30)), Utc(2026, 8, 5, 12, 0)));

    [Fact]
    public void DisabledSubscriptionIsNeverDue()
    {
        var subscription = Interval(5, lastRun: null);
        subscription.Enabled = false;
        Assert.False(IsDueUtc(subscription, Utc(2026, 8, 5, 12, 0)));
    }

    // ---------- daily ----------

    [Fact]
    public void DailyDueOncePastScheduledTime()
    {
        var subscription = Daily(9 * 60, created: Utc(2026, 8, 4, 15, 0)); // created yesterday afternoon
        Assert.False(IsDueUtc(subscription, Utc(2026, 8, 5, 8, 59)));
        Assert.True(IsDueUtc(subscription, Utc(2026, 8, 5, 9, 0)));
        Assert.True(IsDueUtc(subscription, Utc(2026, 8, 5, 23, 59)));
    }

    [Fact]
    public void DailyDoesNotFireTwiceForTheSameDay()
    {
        var subscription = Daily(9 * 60, created: Utc(2026, 8, 1), lastRun: Utc(2026, 8, 5, 9, 1));
        Assert.False(IsDueUtc(subscription, Utc(2026, 8, 5, 12, 0)));
        Assert.True(IsDueUtc(subscription, Utc(2026, 8, 6, 9, 0))); // next day fires again
    }

    [Fact]
    public void DailyCreatedAfterTodaysSlotWaitsForTomorrow()
    {
        var subscription = Daily(9 * 60, created: Utc(2026, 8, 5, 10, 30));
        Assert.False(IsDueUtc(subscription, Utc(2026, 8, 5, 11, 0)));
        Assert.True(IsDueUtc(subscription, Utc(2026, 8, 6, 9, 0)));
    }

    [Fact]
    public void DailyMissedSlotStillFiresLate()
    {
        // Host was down at 09:00; the 14:23 tick still delivers today's run.
        var subscription = Daily(9 * 60, created: Utc(2026, 8, 1), lastRun: Utc(2026, 8, 4, 9, 0));
        Assert.True(IsDueUtc(subscription, Utc(2026, 8, 5, 14, 23)));
    }

    [Fact]
    public void DailyIsDstAgnostic()
    {
        // US DST starts 2026-03-08; with zone=UTC a 02:30 schedule stays pure
        // UTC math and fires exactly once on both sides of the transition.
        var subscription = Daily(150, created: Utc(2026, 3, 6), lastRun: Utc(2026, 3, 7, 2, 30));
        Assert.False(IsDueUtc(subscription, Utc(2026, 3, 7, 23, 59)));
        Assert.True(IsDueUtc(subscription, Utc(2026, 3, 8, 2, 30)));

        subscription.LastRunUtc = Utc(2026, 3, 8, 2, 30);
        Assert.False(IsDueUtc(subscription, Utc(2026, 3, 8, 23, 59)));
        Assert.True(IsDueUtc(subscription, Utc(2026, 3, 9, 2, 30)));
    }

    // ---------- weekly ----------

    [Fact]
    public void WeeklyDueOnScheduledDayAndTime()
    {
        // 2026-08-05 is a Wednesday (day 3); last run was last week's slot.
        var subscription = Weekly(3, 8 * 60, created: Utc(2026, 7, 1), lastRun: Utc(2026, 7, 29, 8, 0));
        Assert.False(IsDueUtc(subscription, Utc(2026, 8, 5, 7, 59)));
        Assert.True(IsDueUtc(subscription, Utc(2026, 8, 5, 8, 0)));
    }

    [Fact]
    public void WeeklyDoesNotRefireUntilNextWeek()
    {
        var subscription = Weekly(3, 8 * 60, created: Utc(2026, 7, 1), lastRun: Utc(2026, 8, 5, 8, 2));
        Assert.False(IsDueUtc(subscription, Utc(2026, 8, 6, 8, 0))); // Thursday
        Assert.False(IsDueUtc(subscription, Utc(2026, 8, 11, 8, 0))); // Tuesday next week
        Assert.True(IsDueUtc(subscription, Utc(2026, 8, 12, 8, 0))); // Wednesday next week
    }

    [Fact]
    public void WeeklyMissedSlotFiresLaterInTheWeek()
    {
        var subscription = Weekly(3, 8 * 60, created: Utc(2026, 7, 1), lastRun: Utc(2026, 7, 29, 8, 0));
        Assert.True(IsDueUtc(subscription, Utc(2026, 8, 7, 16, 40))); // Friday, missed Wednesday
    }

    [Fact]
    public void WeeklyCreatedAfterThisWeeksSlotWaitsForNextWeek()
    {
        var subscription = Weekly(3, 8 * 60, created: Utc(2026, 8, 5, 12, 0)); // Wednesday noon
        Assert.False(IsDueUtc(subscription, Utc(2026, 8, 6, 8, 0)));
        Assert.True(IsDueUtc(subscription, Utc(2026, 8, 12, 8, 0)));
    }

    [Fact]
    public void MalformedScheduleIsNeverDue()
    {
        var noTime = Daily(0, created: Utc(2026, 8, 1));
        noTime.TimeOfDayMinutesUtc = null;
        Assert.False(IsDueUtc(noTime, Utc(2026, 8, 5, 12, 0)));

        var badDay = Weekly(9, 8 * 60, created: Utc(2026, 7, 1));
        Assert.False(IsDueUtc(badDay, Utc(2026, 8, 5, 12, 0)));
    }

    // ---------- schedule zone (America/Chicago) ----------

    [Fact]
    public void DailyHonorsScheduleZoneOffset()
    {
        // 09:00 CT in August is CDT (UTC-5): due at 14:00 UTC, not 09:00 UTC.
        var subscription = Daily(9 * 60, created: Utc(2026, 8, 1), lastRun: Utc(2026, 8, 4, 14, 0));
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 13, 59), Chicago));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 14, 0), Chicago));

        // The SAME record under zone=UTC is due five hours earlier — the zone,
        // not the stored minutes, decides the instant.
        var utcTwin = Daily(9 * 60, created: Utc(2026, 8, 1), lastRun: Utc(2026, 8, 4, 9, 0));
        Assert.False(IsDueUtc(utcTwin, Utc(2026, 8, 5, 8, 59)));
        Assert.True(IsDueUtc(utcTwin, Utc(2026, 8, 5, 9, 0)));
    }

    [Fact]
    public void WeeklyResolvesDayOnTheZoneCalendar()
    {
        // Monday 22:00 CT is TUESDAY 03:00 UTC (CDT): the weekday must resolve
        // on the Chicago calendar, not the UTC one.
        var subscription = Weekly(1, 22 * 60, created: Utc(2026, 7, 1), lastRun: Utc(2026, 7, 28, 3, 0));
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 8, 4, 2, 59), Chicago));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 4, 3, 0), Chicago));
        Assert.Equal(
            Utc(2026, 8, 4, 3, 0),
            ScheduleDue.MostRecentOccurrenceUtc(subscription, Utc(2026, 8, 5, 12, 0), Chicago));
    }

    [Fact]
    public void SpringForwardGapAdvancesByTheGap()
    {
        // Chicago 2026-03-08: clocks jump 02:00 CST -> 03:00 CDT, so 02:30
        // local never happens. The occurrence advances by the one-hour gap to
        // 03:30 CDT = 08:30 UTC — the same instant 02:30 CST would have been —
        // instead of silently skipping the day.
        var subscription = Daily(150, created: Utc(2026, 3, 1), lastRun: Utc(2026, 3, 7, 8, 30));
        Assert.Equal(
            Utc(2026, 3, 8, 8, 30),
            ScheduleDue.MostRecentOccurrenceUtc(subscription, Utc(2026, 3, 8, 12, 0), Chicago));
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 3, 8, 8, 29), Chicago));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 3, 8, 8, 30), Chicago));
    }

    [Fact]
    public void FallBackAmbiguityMapsToStandardTime()
    {
        // Chicago 2026-11-01: clocks fall back 02:00 CDT -> 01:00 CST, so
        // 01:30 local happens twice (06:30 UTC as CDT, 07:30 UTC as CST).
        // ConvertTimeToUtc's documented default picks STANDARD time — the
        // SECOND occurrence — so the day sends exactly once, at 07:30 UTC.
        var subscription = Daily(90, created: Utc(2026, 10, 1), lastRun: Utc(2026, 10, 31, 6, 30));
        Assert.Equal(
            Utc(2026, 11, 1, 7, 30),
            ScheduleDue.MostRecentOccurrenceUtc(subscription, Utc(2026, 11, 1, 12, 0), Chicago));
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 11, 1, 6, 30), Chicago)); // first (CDT) pass: not a slot
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 11, 1, 7, 29), Chicago));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 11, 1, 7, 30), Chicago));
    }

    [Fact]
    public void IntervalIsZoneIndependent()
    {
        var subscription = Interval(30, Utc(2026, 8, 5, 11, 30));
        Assert.Equal(
            IsDueUtc(subscription, Utc(2026, 8, 5, 12, 0)),
            ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 12, 0), Chicago));
        Assert.True(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 12, 0), Chicago));
        Assert.False(ScheduleDue.IsDue(subscription, Utc(2026, 8, 5, 11, 59), Chicago));
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
