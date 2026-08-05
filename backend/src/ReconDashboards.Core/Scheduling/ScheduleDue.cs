using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Core.Scheduling;

/// <summary>
/// Pure UTC due-time math for subscriptions and alerts. Everything is plain
/// UTC arithmetic — no time zones, no DST transitions, no cron.
/// </summary>
public static class ScheduleDue
{
    /// <summary>
    /// True when the subscription should run at <paramref name="nowUtc"/>.
    /// Interval: LastRun is null (first tick) or one interval has elapsed.
    /// Daily/Weekly: the most recent scheduled occurrence at or before now is
    /// later than the baseline (LastRun, or CreatedUtc for a never-run
    /// subscription — so a subscription created after today's slot does not
    /// fire immediately).
    /// </summary>
    public static bool IsDue(SubscriptionRecord subscription, DateTime nowUtc)
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
                var occurrence = MostRecentOccurrenceUtc(subscription, nowUtc);
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
    /// The latest daily/weekly scheduled instant at or before <paramref name="nowUtc"/>;
    /// null for interval subscriptions or malformed schedules.
    /// </summary>
    public static DateTime? MostRecentOccurrenceUtc(SubscriptionRecord subscription, DateTime nowUtc)
    {
        if (subscription.TimeOfDayMinutesUtc is not { } minutes || minutes is < 0 or > 1439)
        {
            return null;
        }

        var timeOfDay = TimeSpan.FromMinutes(minutes);

        switch (subscription.ScheduleKind)
        {
            case SubscriptionScheduleKind.Daily:
                var today = nowUtc.Date + timeOfDay;
                return today <= nowUtc ? today : today.AddDays(-1);

            case SubscriptionScheduleKind.Weekly:
                if (subscription.DayOfWeekUtc is not { } day || day is < 0 or > 6)
                {
                    return null;
                }

                var daysBack = ((int)nowUtc.DayOfWeek - day + 7) % 7;
                var candidate = nowUtc.Date.AddDays(-daysBack) + timeOfDay;
                return candidate <= nowUtc ? candidate : candidate.AddDays(-7);

            default:
                return null;
        }
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
