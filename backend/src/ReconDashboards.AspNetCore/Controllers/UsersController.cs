using Microsoft.AspNetCore.Mvc;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Abstractions;

namespace ReconDashboards.AspNetCore.Controllers;

/// <summary>
/// The share-picker directory. Backed by the host's IUserDirectory; with the
/// default NullUserDirectory this returns an empty list and the Share dialog
/// shows its "user directory not configured" state.
/// </summary>
[Route("users")]
public sealed class UsersController(IUserDirectory userDirectory) : RcdControllerBase
{
    [HttpGet]
    [RcdPolicySlot(RcdPolicySlot.View)]
    public async Task<IReadOnlyList<RcdUserResponse>> List([FromQuery] string? query, CancellationToken ct) =>
        (await userDirectory.ListUsersAsync(query, ct))
            .Select(u => new RcdUserResponse(u.UserId, u.DisplayName, u.Email))
            .ToArray();
}
