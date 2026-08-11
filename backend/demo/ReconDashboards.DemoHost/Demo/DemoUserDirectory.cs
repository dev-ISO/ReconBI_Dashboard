using ReconDashboards.Core.Abstractions;

namespace ReconDashboards.DemoHost.Demo;

/// <summary>
/// IUserDirectory over the canned demo users: what a production host implements
/// over its own Users table so share pickers and activity entries show names.
/// </summary>
public sealed class DemoUserDirectory : IUserDirectory
{
    public Task<IReadOnlyList<RcdUserInfo>> ListUsersAsync(string? query, CancellationToken ct)
    {
        var users = DemoTokens.Users
            .Where(u => string.IsNullOrWhiteSpace(query)
                || u.Username.Contains(query, StringComparison.OrdinalIgnoreCase)
                || u.DisplayName.Contains(query, StringComparison.OrdinalIgnoreCase))
            .Select(ToInfo)
            .ToArray();
        return Task.FromResult<IReadOnlyList<RcdUserInfo>>(users);
    }

    public Task<IReadOnlyDictionary<string, RcdUserInfo>> ResolveAsync(
        IEnumerable<string> userIds, CancellationToken ct)
    {
        var resolved = userIds
            .Where(id => !string.IsNullOrEmpty(id))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(id => DemoTokens.FindUser(id) is { } user ? ToInfo(user) : new RcdUserInfo(id, id, null))
            .ToDictionary(info => info.UserId, StringComparer.Ordinal);
        return Task.FromResult<IReadOnlyDictionary<string, RcdUserInfo>>(resolved);
    }

    private static RcdUserInfo ToInfo(DemoUser user) =>
        new(user.Username, user.DisplayName, $"{user.Username}@demo.local");
}
