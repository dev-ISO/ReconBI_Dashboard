using Npgsql;
using ReconDashboards.Core.Schema;
using Testcontainers.PostgreSql;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// Starts one postgres:17-alpine container for the whole "postgres" collection,
/// seeds a demo schema, and exposes an <see cref="NpgsqlDataSource"/> plus a
/// ready-made introspector (connection name "it-demo") and a cached raw
/// introspection snapshot.
/// </summary>
public sealed class PostgresContainerFixture : IAsyncLifetime
{
    public const string ConnectionName = "it-demo";

    private const string SeedDdl = """
        CREATE TYPE order_status AS ENUM ('open','closed','cancelled');
        CREATE DOMAIN money_amount AS numeric(12,2);

        CREATE TABLE customers (
            id serial PRIMARY KEY,
            name text NOT NULL UNIQUE,
            region text NULL,
            credit_limit money_amount,
            created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE orders (
            id serial PRIMARY KEY,
            customer_id int NULL REFERENCES customers(id),
            status order_status NOT NULL,
            order_total numeric(12,2),
            order_date date,
            payload jsonb,
            attachment bytea,
            tags int[]
        );

        CREATE TABLE calendar (
            year int,
            week int,
            label text,
            PRIMARY KEY (year, week)
        );

        CREATE TABLE slots (
            year int,
            week int,
            note text,
            FOREIGN KEY (year, week) REFERENCES calendar (year, week)
        );

        CREATE TABLE "Weird Name" ("Weird Col" text, plain int);

        -- Known series with deliberate gaps for time-intelligence calc tests:
        -- region A skips 2025-03 and 2026-03; region B stops after 2025-04.
        CREATE TABLE monthly_sales (
            id serial PRIMARY KEY,
            sale_date date NOT NULL,
            region text NOT NULL,
            amount numeric(12,2) NOT NULL
        );

        INSERT INTO monthly_sales (sale_date, region, amount) VALUES
            ('2025-01-15', 'A', 100),
            ('2025-02-15', 'A', 200),
            ('2025-04-15', 'A', 400),
            ('2026-01-15', 'A', 150),
            ('2026-02-15', 'A', 260),
            ('2026-04-15', 'A', 480),
            ('2025-01-20', 'B', 50),
            ('2025-02-20', 'B', 60),
            ('2025-04-20', 'B', 80);

        CREATE VIEW open_orders AS SELECT * FROM orders WHERE status = 'open';

        CREATE MATERIALIZED VIEW region_totals AS
            SELECT c.region, sum(o.order_total) AS total
            FROM orders o
            JOIN customers c ON c.id = o.customer_id
            GROUP BY c.region;

        COMMENT ON TABLE customers IS 'Customer master';
        COMMENT ON COLUMN customers.region IS 'Sales region';

        INSERT INTO customers (name, region, credit_limit)
        SELECT 'Customer ' || i,
               (ARRAY['North','South','East','West'])[1 + i % 4],
               (1000 + i * 10)::numeric(12,2)
        FROM generate_series(1, 50) AS i;

        INSERT INTO orders (customer_id, status, order_total, order_date, payload, attachment, tags)
        SELECT 1 + i % 50,
               (ARRAY['open','closed','cancelled'])[1 + i % 3]::order_status,
               (i * 1.25)::numeric(12,2),
               date '2026-01-01' + (i % 90),
               jsonb_build_object('n', i),
               decode('deadbeef', 'hex'),
               ARRAY[i, i + 1]
        FROM generate_series(1, 200) AS i;
        """;

    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder("postgres:17-alpine").Build();

    private NpgsqlDataSource? _dataSource;
    private PostgresSchemaIntrospector? _introspector;
    private DatabaseSchema? _rawSchema;

    public NpgsqlDataSource DataSource =>
        _dataSource ?? throw new InvalidOperationException("Fixture not initialized.");

    public PostgresSchemaIntrospector Introspector =>
        _introspector ?? throw new InvalidOperationException("Fixture not initialized.");

    /// <summary>Raw (unfiltered, unhashed) snapshot taken once after seeding.</summary>
    public DatabaseSchema RawSchema =>
        _rawSchema ?? throw new InvalidOperationException("Fixture not initialized.");

    public async Task InitializeAsync()
    {
        await _container.StartAsync();
        _dataSource = NpgsqlDataSource.Create(_container.GetConnectionString());

        await using (var connection = await _dataSource.OpenConnectionAsync())
        {
            await using (var seed = new NpgsqlCommand(SeedDdl, connection))
            {
                await seed.ExecuteNonQueryAsync();
            }

            await using (var refresh = new NpgsqlCommand("REFRESH MATERIALIZED VIEW region_totals;", connection))
            {
                await refresh.ExecuteNonQueryAsync();
            }

            await using (var analyze = new NpgsqlCommand("ANALYZE;", connection))
            {
                await analyze.ExecuteNonQueryAsync();
            }
        }

        _introspector = new PostgresSchemaIntrospector(_dataSource, ConnectionName);
        _rawSchema = await _introspector.IntrospectAsync(CancellationToken.None);
    }

    public async Task DisposeAsync()
    {
        if (_dataSource is not null)
        {
            await _dataSource.DisposeAsync();
        }

        await _container.DisposeAsync();
    }
}

[CollectionDefinition("postgres")]
public sealed class PostgresCollection : ICollectionFixture<PostgresContainerFixture>;
