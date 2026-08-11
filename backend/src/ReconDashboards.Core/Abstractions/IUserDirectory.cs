namespace ReconDashboards.Core.Abstractions;

/// <summary>A directory entry the share picker and activity log can display.</summary>
public sealed record RcdUserInfo(string UserId, string DisplayName, string? Email);

/// <summary>
/// Host-implemented user directory (optional). Backs the share-picker search
/// and decorates share lists / activity entries / summaries with display
/// names. Like <see cref="ICurrentUserProvider"/>, ids are opaque host
/// strings — the library never joins into host tables. When the host does not
/// register an implementation, <see cref="NullUserDirectory"/> applies: the
/// directory lists nothing and ids echo back as display names.
/// </summary>
public interface IUserDirectory
{
    /// <summary>Users matching <paramref name="query"/> (null/empty = all), for the share picker.</summary>
    Task<IReadOnlyList<RcdUserInfo>> ListUsersAsync(string? query, CancellationToken ct);

    /// <summary>
    /// Batch id → user resolution. Ids without a directory entry may be
    /// omitted; callers fall back to the raw id. Never called per-row.
    /// </summary>
    Task<IReadOnlyDictionary<string, RcdUserInfo>> ResolveAsync(
        IEnumerable<string> userIds, CancellationToken ct);
}

/// <summary>
/// Default when the host registers no <see cref="IUserDirectory"/>: empty
/// listing (UIs show a "directory not configured" state) and Resolve echoing
/// each id as its own display name.
/// </summary>
public sealed class NullUserDirectory : IUserDirectory
{
    public Task<IReadOnlyList<RcdUserInfo>> ListUsersAsync(string? query, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<RcdUserInfo>>([]);

    public Task<IReadOnlyDictionary<string, RcdUserInfo>> ResolveAsync(
        IEnumerable<string> userIds, CancellationToken ct)
    {
        var resolved = userIds
            .Where(id => !string.IsNullOrEmpty(id))
            .Distinct(StringComparer.Ordinal)
            .ToDictionary(id => id, id => new RcdUserInfo(id, id, null), StringComparer.Ordinal);
        return Task.FromResult<IReadOnlyDictionary<string, RcdUserInfo>>(resolved);
    }
}
