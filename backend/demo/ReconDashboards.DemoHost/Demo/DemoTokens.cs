using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace ReconDashboards.DemoHost.Demo;

public sealed record DemoLoginRequest(string Username);

public sealed record DemoUser(string Username, string DisplayName, string Role, string? RegionScope);

public sealed record DemoLoginResponse(string Token, string Username, string DisplayName, string Role);

public static class DemoTokens
{
    public const string Issuer = "ReconDashboardsDemo";
    public const string Audience = "ReconDashboardsDemo";

    /// <summary>
    /// alice: author, row-scoped to Gulf Coast sites (proves IRowFilterContributor end to end).
    /// bob: viewer only. carol: admin (can share/unshare and edit shared resources).
    /// </summary>
    public static readonly IReadOnlyList<DemoUser> Users =
    [
        new("alice", "Alice (author, Gulf Coast only)", "Author", "Gulf Coast"),
        new("bob", "Bob (viewer)", "Member", null),
        new("carol", "Carol (admin)", "Admin", null),
    ];

    public static DemoUser? FindUser(string username) =>
        Users.FirstOrDefault(u => string.Equals(u.Username, username, StringComparison.OrdinalIgnoreCase));

    public static DemoLoginResponse Issue(DemoUser user, string tokenKey)
    {
        var credentials = new SigningCredentials(
            new SymmetricSecurityKey(Encoding.UTF8.GetBytes(tokenKey)),
            SecurityAlgorithms.HmacSha256);

        var token = new JwtSecurityToken(
            issuer: Issuer,
            audience: Audience,
            claims:
            [
                new Claim(ClaimTypes.NameIdentifier, user.Username),
                new Claim(ClaimTypes.Name, user.DisplayName),
                new Claim(ClaimTypes.Role, user.Role),
            ],
            expires: DateTime.UtcNow.AddHours(8),
            signingCredentials: credentials);

        return new DemoLoginResponse(
            new JwtSecurityTokenHandler().WriteToken(token),
            user.Username,
            user.DisplayName,
            user.Role);
    }
}
