using Npgsql;
using ReconDashboards.Core.Options;

namespace ReconDashboards.Postgres;

public static class PostgresReconDashboardsOptionsExtensions
{
    /// <summary>
    /// Registers a PostgreSQL data source for charting. Lives in the Postgres
    /// package (extension on the options object) so the ASP.NET layer carries
    /// no provider references. The NpgsqlDataSource is created lazily, once,
    /// and shared by the introspector and (later) the query executor.
    /// </summary>
    public static ReconDashboardsOptions AddPostgresDataSource(
        this ReconDashboardsOptions options,
        string name,
        Action<DataSourceOptions> configure)
    {
        ArgumentNullException.ThrowIfNull(configure);

        var dataSourceOptions = new DataSourceOptions();
        configure(dataSourceOptions);

        if (string.IsNullOrWhiteSpace(dataSourceOptions.ConnectionString))
        {
            throw new InvalidOperationException(
                $"Data source '{name}' has no connection string. Set DataSourceOptions.ConnectionString from host configuration.");
        }

        var lazyDataSource = new Lazy<NpgsqlDataSource>(
            () => BuildDataSource(dataSourceOptions),
            LazyThreadSafetyMode.ExecutionAndPublication);

        options.RegisterDataSource(new DataSourceRegistration(
            name,
            ProviderName: "postgres",
            dataSourceOptions,
            IntrospectorFactory: _ => new PostgresSchemaIntrospector(lazyDataSource.Value, name)));

        return options;
    }

    private static NpgsqlDataSource BuildDataSource(DataSourceOptions options)
    {
        var builder = new NpgsqlConnectionStringBuilder(options.ConnectionString);

        if (options.EnforceReadOnlySession)
        {
            // Session-level guards. A dedicated SELECT-only role remains the
            // recommended first line of defense; this is the second.
            var extra = $"-c default_transaction_read_only=on -c statement_timeout={options.StatementTimeoutSeconds * 1000}";
            builder.Options = string.IsNullOrEmpty(builder.Options)
                ? extra
                : $"{builder.Options} {extra}";
        }

        return NpgsqlDataSource.Create(builder.ConnectionString);
    }
}
