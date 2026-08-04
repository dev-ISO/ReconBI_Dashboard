using System.Security.Claims;
using ReconDashboards.Core.Abstractions;

namespace ReconDashboards.DemoHost.Demo;

/// <summary>
/// The host-side identity seam: JWT NameIdentifier becomes the opaque user id
/// the library stores; the Admin role maps to shared-resource management.
/// Production hosts implement the same two members over their own auth.
/// </summary>
public sealed class DemoCurrentUserProvider(IHttpContextAccessor httpContextAccessor) : ICurrentUserProvider
{
    private ClaimsPrincipal User =>
        httpContextAccessor.HttpContext?.User
        ?? throw new InvalidOperationException("No HTTP context.");

    public string GetUserId() =>
        User.FindFirstValue(ClaimTypes.NameIdentifier)
        ?? throw new InvalidOperationException("The current request has no authenticated user.");

    public bool CanManageShared => User.IsInRole("Admin");
}
