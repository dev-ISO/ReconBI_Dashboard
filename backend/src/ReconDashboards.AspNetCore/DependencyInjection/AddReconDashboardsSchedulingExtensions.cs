using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Email;
using ReconDashboards.Core.Scheduling;

namespace ReconDashboards.AspNetCore.DependencyInjection;

public static class AddReconDashboardsSchedulingExtensions
{
    /// <summary>
    /// Opt-in background evaluation of dashboard subscriptions and data
    /// alerts: a hosted service ticks once per minute and processes due
    /// records under each record OWNER's row-filter identity.
    ///
    /// When <paramref name="configuration"/> is provided, an
    /// <see cref="IRcdEmailSender"/> is registered from the "Rcd:Email"
    /// section: SMTP (Host/Port/From/User/Password/UseSsl) when Host is set,
    /// otherwise a <see cref="FileEmailSink"/> writing .eml files to
    /// Rcd:Email:DropFolder (default "rcd-emails" under the app base
    /// directory) so everything works locally without an SMTP server. Hosts
    /// may also register their own IRcdEmailSender before calling this.
    /// </summary>
    public static IServiceCollection AddReconDashboardsScheduling(
        this IServiceCollection services, IConfiguration? configuration = null)
    {
        if (configuration is not null)
        {
            var email = new RcdEmailOptions();
            configuration.GetSection("Rcd:Email").Bind(email);
            services.TryAddSingleton(email);
            services.TryAddSingleton<IRcdEmailSender>(sp =>
                string.IsNullOrWhiteSpace(email.Host)
                    ? new FileEmailSink(
                        ResolveDropFolder(email.DropFolder),
                        sp.GetRequiredService<TimeProvider>())
                    : new SmtpEmailSender(email));
        }

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<SchedulingEvaluator>();
        services.AddHostedService<RcdSchedulerService>();
        return services;
    }

    private static string ResolveDropFolder(string? configured) =>
        string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(AppContext.BaseDirectory, "rcd-emails")
            : Path.GetFullPath(configured);
}

/// <summary>
/// Minute ticker for <see cref="SchedulingEvaluator"/>. The loop is strictly
/// sequential and additionally guarded, so a slow evaluation can never overlap
/// the next tick; failures are logged and never crash the host.
/// </summary>
internal sealed class RcdSchedulerService(
    SchedulingEvaluator evaluator,
    ILogger<RcdSchedulerService> logger) : BackgroundService
{
    private int _running;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                if (Interlocked.Exchange(ref _running, 1) == 1)
                {
                    logger.LogWarning("Previous scheduling pass still running; skipping this tick");
                    continue;
                }

                try
                {
                    await evaluator.RunOnceAsync(stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Scheduling pass failed; will retry next tick");
                }
                finally
                {
                    Volatile.Write(ref _running, 0);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
    }
}
