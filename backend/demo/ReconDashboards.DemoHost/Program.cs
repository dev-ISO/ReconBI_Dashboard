using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using ReconDashboards.AspNetCore.DependencyInjection;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.DemoHost.Demo;
using ReconDashboards.Postgres;

// Parity with the production hosts: plain UTC DateTime <-> timestamp without time zone.
AppContext.SetSwitch("Npgsql.EnableLegacyTimestampBehavior", true);

var builder = WebApplication.CreateBuilder(args);

var tokenKey = builder.Configuration["TokenKey"]
    ?? throw new InvalidOperationException("TokenKey is not configured.");
var storageConnection = builder.Configuration.GetConnectionString("Storage")
    ?? throw new InvalidOperationException("ConnectionStrings:Storage is not configured.");
var demoDataConnection = builder.Configuration.GetConnectionString("DemoData")
    ?? throw new InvalidOperationException("ConnectionStrings:DemoData is not configured.");

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(tokenKey)),
            ValidateIssuer = true,
            ValidIssuer = DemoTokens.Issuer,
            ValidateAudience = true,
            ValidAudience = DemoTokens.Audience,
            ClockSkew = TimeSpan.FromMinutes(1),
        };
    });

builder.Services.AddAuthorization(options =>
{
    // Deny-by-default, exactly like the production hosts.
    options.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build();
    options.AddPolicy("RcdAuthor", policy => policy.RequireRole("Author", "Admin"));
    options.AddPolicy("RcdAdmin", policy => policy.RequireRole("Admin"));
});

builder.Services.AddControllers()
    .AddReconDashboards(rcd =>
    {
        rcd.RoutePrefix = "api/rcd";
        rcd.ViewPolicy = null; // fallback policy already requires authentication
        rcd.AuthorPolicy = "RcdAuthor";
        rcd.AdminPolicy = "RcdAdmin";
        rcd.EnableQueryAudit = true;
        rcd.IncludeSqlInResponse = true; // honored in Development only
        rcd.ConfigureStorage = o => o.UseNpgsql(storageConnection, npgsql => npgsql
            .MigrationsAssembly("ReconDashboards.Postgres")
            .MigrationsHistoryTable("__RcdMigrationsHistory"));
        rcd.AddPostgresDataSource("demo", ds =>
        {
            ds.ConnectionString = demoDataConnection;
            ds.Description = "Seeded plant-maintenance demo database (read-only chart_reader role)";
        });

        // Optional extra sources (e.g. other apps' LOCAL dev databases) from
        // configuration that never gets committed (appsettings.Development.json
        // is gitignored). Sessions are read-only by default; nothing in those
        // databases is ever modified.
        foreach (var section in builder.Configuration.GetSection("ExtraDataSources").GetChildren())
        {
            var extraConnection = section["ConnectionString"];
            if (!string.IsNullOrWhiteSpace(extraConnection))
            {
                rcd.AddPostgresDataSource(section.Key, ds =>
                {
                    ds.ConnectionString = extraConnection;
                    ds.Description = section["Description"] ?? "External database (read-only session)";
                });
            }
        }
    });

// Opt-in scheduling: subscriptions + data alerts evaluated once per minute.
// With no Rcd:Email:Host configured this uses the FileEmailSink drop folder,
// so snapshots/alerts are testable locally without SMTP.
builder.Services.AddReconDashboardsScheduling(builder.Configuration);

builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUserProvider, DemoCurrentUserProvider>();
// Share-picker directory over the canned demo users (hosts: your Users table).
builder.Services.AddSingleton<IUserDirectory, DemoUserDirectory>();
// Row-level scoping demo: alice only ever sees Gulf Coast sites. FAIL CLOSED.
builder.Services.AddScoped<IRowFilterContributor, DemoRowFilterContributor>();

var app = builder.Build();

app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();

app.MapGet("/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();

// Canned demo users; see DemoTokens.Users. No passwords — this is a demo host.
app.MapPost("/api/demo-login", (DemoLoginRequest request) =>
{
    var user = DemoTokens.FindUser(request.Username);
    return user is null
        ? Results.NotFound(new { error = $"Unknown demo user '{request.Username}'. Try alice, bob, or carol." })
        : Results.Ok(DemoTokens.Issue(user, tokenKey));
}).AllowAnonymous();

app.MapControllers();

app.Run();

public partial class Program; // exposes the host to WebApplicationFactory in Api.Tests
