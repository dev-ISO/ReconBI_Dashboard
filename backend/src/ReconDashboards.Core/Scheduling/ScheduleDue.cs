using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Core.Scheduling;

/// <summary>
/// Due-time math for subscriptions and alerts. Interval and alert cadences are
/// pure UTC arithmetic; daily/weekly occurrences are computed as wall-clock
/// times in the host-configured schedule zone
/// (<see cref="Options.ReconDashboardsOptions.ScheduleTimeZoneId"/>) and
/// converted back to UTC for comparison — "07:00" means 07:00 at the plant,
/// year-round, across DST transitions. No cron.
/// </summary>
public static class ScheduleDue
{
    /// <summary>
    /// True when the subscription should run at <paramref name="nowUtc"/>.
    /// Interval: LastRun is null (first tick) or one interval has elapsed.
    /// Daily/Weekly: the most recent scheduled occurrence (in
    /// <paramref name="scheduleZone"/> wall-clock time) at or before now is
    /// later than the baseline (LastRun, or CreatedUtc for a never-run
    /// subscription — so a subscription created after today's slot does not
    /// fire immediately).
    /// </summary>
    public static bool IsDue(SubscriptionRecord subscription, DateTime nowUtc, TimeZoneInfo scheduleZone)
    {
        if (!subscription.Enabled)
        {
            return false;
        }

        switch (subscription.ScheduleKind)
        {
            case SubscriptionScheduleKind.Interval:
                var interval = TimeSpan.FromMinutes(Math.Max(subscription.IntervalMinutes ?? 60, 1));
                return subscription.LastRunUtc is not { } lastRun || nowUtc >= lastRun + interval;

            case SubscriptionScheduleKind.Daily:
            case SubscriptionScheduleKind.Weekly:
                var occurrence = MostRecentOccurrenceUtc(subscription, nowUtc, scheduleZone);
                if (occurrence is not { } scheduled)
                {
                    return false;
                }

                var baseline = subscription.LastRunUtc ?? subscription.CreatedUtc;
                return scheduled > baseline;

            default:
                return false;
        }
    }

    /// <summary>
    /// The latest daily/weekly scheduled instant (as UTC) at or before
    /// <paramref name="nowUtc"/>; null for interval subscriptions or malformed
    /// schedules. The stored time-of-day / weekday are wall-clock values in
    /// <paramref name="scheduleZone"/>, so the occurrence is built on the
    /// zone's calendar and converted back to UTC — comparisons stay in UTC so
    /// dates flipping at the zone boundary cannot skew "today".
    /// </summary>
    public static DateTime? MostRecentOccurrenceUtc(
        SubscriptionRecord subscription, DateTime nowUtc, TimeZoneInfo scheduleZone)
    {
        // Historical column name — the value is minutes past LOCAL midnight in
        // scheduleZone (see ReconDashboardsOptions.ScheduleTimeZoneId).
        if (subscription.TimeOfDayMinutesUtc is not { } minutes || minutes is < 0 or > 1439)
        {
            return null;
        }

        var timeOfDay = TimeSpan.FromMinutes(minutes);
        var nowLocal = TimeZoneInfo.ConvertTimeFromUtc(nowUtc, scheduleZone);

        switch (subscription.ScheduleKind)
        {
            case SubscriptionScheduleKind.Daily:
                var todayUtc = LocalToUtc(nowLocal.Date + timeOfDay, scheduleZone);
                return todayUtc <= nowUtc
                    ? todayUtc
                    : LocalToUtc(nowLocal.Date.AddDays(-1) + timeOfDay, scheduleZone);

            case SubscriptionScheduleKind.Weekly:
                if (subscription.DayOfWeekUtc is not { } day || day is < 0 or > 6)
                {
                    return null;
                }

                var daysBack = ((int)nowLocal.DayOfWeek - day + 7) % 7;
                var candidateLocal = nowLocal.Date.AddDays(-daysBack) + timeOfDay;
                var candidateUtc = LocalToUtc(candidateLocal, scheduleZone);
                return candidateUtc <= nowUtc
                    ? candidateUtc
                    : LocalToUtc(candidateLocal.AddDays(-7), scheduleZone);

            default:
                return null;
        }
    }

    /// <summary>
    /// Zone-local wall time -> UTC instant, with both DST edges pinned down:
    ///  - INVALID local time (spring-forward gap, e.g. 02:30 on a US
    ///    transition day): the wall time never happens, so the occurrence
    ///    advances by the gap (offset after the transition minus offset
    ///    before) — a 02:30 schedule effectively runs at 03:30 that day, the
    ///    same instant it would have been without the jump. Skipping the day
    ///    entirely would silently drop a send once a year.
    ///  - AMBIGUOUS local time (fall-back overlap, e.g. 01:30 occurring
    ///    twice): ConvertTimeToUtc's documented default maps to STANDARD
    ///    time — the SECOND occurrence. One send per calendar day, at the
    ///    later instant; the earlier DST-side 01:30 is not a slot.
    /// </summary>
    private static DateTime LocalToUtc(DateTime local, TimeZoneInfo zone)
    {
        if (zone.IsInvalidTime(local))
        {
            // A day on either side of the gap is safely outside any transition
            // window (real-world gaps are 30-60 minutes), so the offset
            // difference IS the gap width.
            var gap = zone.GetUtcOffset(local.AddDays(1)) - zone.GetUtcOffset(local.AddDays(-1));
            local += gap;
        }

        return TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), zone);
    }

    /// <summary>True when the alert's evaluation cadence has elapsed.</summary>
    public static bool IsAlertDue(AlertRecord alert, DateTime nowUtc)
    {
        if (!alert.Enabled)
        {
            return false;
        }

        var cadence = TimeSpan.FromMinutes(Math.Max(alert.EveryMinutes, 1));
        return alert.LastEvaluatedUtc is not { } evaluated || nowUtc >= evaluated + cadence;
    }

    /// <summary>True when the alert may fire again (no prior firing, or the cooldown elapsed).</summary>
    public static bool CooldownElapsed(AlertRecord alert, DateTime nowUtc) =>
        alert.LastFiredUtc is not { } fired
        || nowUtc >= fired + TimeSpan.FromMinutes(Math.Max(alert.CooldownMinutes, 0));

    /// <summary>Applies the alert's comparison to an evaluated value.</summary>
    public static bool ConditionMet(AlertOperator op, decimal value, decimal threshold) => op switch
    {
        AlertOperator.Gt => value > threshold,
        AlertOperator.Gte => value >= threshold,
        AlertOperator.Lt => value < threshold,
        AlertOperator.Lte => value <= threshold,
        AlertOperator.Eq => value == threshold,
        _ => false,
    };

    /// <summary>"&gt;" / "&gt;=" / ... for alert email text.</summary>
    public static string OperatorSymbol(AlertOperator op) => op switch
    {
        AlertOperator.Gt => ">",
        AlertOperator.Gte => ">=",
        AlertOperator.Lt => "<",
        AlertOperator.Lte => "<=",
        _ => "=",
    };
}
