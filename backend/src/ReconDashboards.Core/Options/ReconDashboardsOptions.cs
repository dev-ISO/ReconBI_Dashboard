using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;

namespace ReconDashboards.Core.Options;

/// <summary>
/// One data source registration: name + options + a provider-supplied
/// introspector factory. Provider packages (e.g. ReconDashboards.Postgres) add
/// these via extension methods on <see cref="ReconDashboardsOptions"/> so the
/// ASP.NET layer stays free of provider references.
/// </summary>
public sealed record DataSourceRegistration(
    string Name,
    string ProviderName,
    DataSourceOptions Options,
    Func<IServiceProvider, ISchemaIntrospector> IntrospectorFactory,
    Func<IServiceProvider, IQueryExecutor>? ExecutorFactory = null,
    ISqlDialect? Dialect = null);

public sealed class ReconDashboardsOptions
{
    /// <summary>Routes are mounted at "{RoutePrefix}/v1/...".</summary>
    public string RoutePrefix { get; set; } = "api/rcd";

    /// <summary>
    /// Authorization policy names the host maps onto its own role/capability
    /// system. Null slots add no extra metadata — the host's fallback policy
    /// (typically RequireAuthenticatedUser) still applies.
    /// </summary>
    public string? ViewPolicy { get; set; }

    /// <summary>Create/edit own models and dashboards; browse catalogs.</summary>
    public string? AuthorPolicy { get; set; }

    /// <summary>Share/unshare, edit shared resources owned by others, view audit.</summary>
    public string? AdminPolicy { get; set; }

    public RcdLimits Limits { get; } = new();

    /// <summary>
    /// Owner id marking built-in (seeded) dashboards/models. Rows owned by this
    /// id are read-only for everyone through the API — update/delete/share
    /// return 403 (rcd.dashboard.system_readonly / rcd.model.system_readonly);
    /// seed scripts remain the only writer. Duplicate stays available to any
    /// viewer. Set to null/empty to disable.
    /// </summary>
    public string? SystemOwnerUserId { get; set; } = "system";

    /// <summary>Write one rcd_query_audit row per executed query.</summary>
    public bool EnableQueryAudit { get; set; }

    /// <summary>
    /// Time zone id (IANA or Windows; resolved via
    /// TimeZoneInfo.FindSystemTimeZoneById) in which daily/weekly subscription
    /// send times are interpreted — "plant local time". Default "UTC"
    /// preserves the original pure-UTC behavior for hosts that never set it.
    /// NOTE the storage columns keep their historical *Utc names
    /// (rcd_subscriptions.TimeOfDayMinutesUtc / DayOfWeekUtc): the VALUES are
    /// minutes past LOCAL midnight / local weekday in THIS zone. Renaming the
    /// columns would force a hand-applied schema migration on every host for
    /// zero user value, so the honesty lives here and on the wire
    /// (timeOfDayLocal / dayOfWeek) instead.
    /// </summary>
    public string ScheduleTimeZoneId { get; set; } = "UTC";

    /// <summary>
    /// Short display label for <see cref="ScheduleTimeZoneId"/> ("CT", "UTC"),
    /// stamped into snapshot/alert emails and surfaced to frontends next to
    /// schedule times. A separate option because .NET has no portable
    /// short-abbreviation API for time zones — the host knows what its plant
    /// calls the zone better than any generated string would.
    /// </summary>
    public string ScheduleTimeZoneLabel { get; set; } = "UTC";

    /// <summary>
    /// In Development only: echo generated SQL in query responses' debug field.
    /// Never honored outside Development.
    /// </summary>
    public bool IncludeSqlInResponse { get; set; }

    /// <summary>
    /// Server-side secret for the HMAC-SHA256 unsubscribe and open-tracking
    /// tokens (any long random string; hosts thread it from an env var such as
    /// RCD_UNSUBSCRIBE_SECRET). The tokens are self-authenticating — no login
    /// identity — so this secret is the only thing standing between a URL and
    /// an opt-out/open write. When this OR <see cref="PublicBaseUrl"/> is
    /// unset, subscription emails simply omit the unsubscribe footer and the
    /// tracking pixel; nothing else degrades and no broken links are ever
    /// emitted. The anonymous endpoints also refuse all tokens (404 page /
    /// blind pixel) so a missing secret can never be probed.
    /// </summary>
    public string? UnsubscribeSecret { get; set; }

    /// <summary>
    /// Absolute public origin the app is reachable at from a mail client
    /// (e.g. the Cloudflare tunnel URL, no trailing slash needed). Used ONLY
    /// to build unsubscribe links and open-pixel URLs in outbound email —
    /// the API itself never redirects to it. When this OR
    /// <see cref="UnsubscribeSecret"/> is unset, emails omit the footer and
    /// pixel gracefully (see UnsubscribeSecret).
    /// </summary>
    public string? PublicBaseUrl { get; set; }

    /// <summary>
    /// Configures the library-owned storage context (rcd_ tables). The host
    /// decides provider and connection, e.g. o => o.UseNpgsql(conn,
    /// n => n.MigrationsAssembly("ReconDashboards.Postgres")).
    /// </summary>
    public Action<DbContextOptionsBuilder>? ConfigureStorage { get; set; }

    private readonly List<DataSourceRegistration> _dataSources = [];

    public IReadOnlyList<DataSourceRegistration> DataSources => _dataSources;

    /// <summary>Called by provider packages' extension methods; not by hosts directly.</summary>
    public void RegisterDataSource(DataSourceRegistration registration)
    {
        ArgumentNullException.ThrowIfNull(registration);
        if (string.IsNullOrWhiteSpace(registration.Name))
        {
            throw new ArgumentException("Data source name must be non-empty.", nameof(registration));
        }

        if (_dataSources.Any(d => string.Equals(d.Name, registration.Name, StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException($"Data source '{registration.Name}' is already registered.");
        }

        _dataSources.Add(registration);
    }
}
