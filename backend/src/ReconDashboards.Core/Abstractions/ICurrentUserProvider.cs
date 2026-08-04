namespace ReconDashboards.Core.Abstractions;

/// <summary>
/// Host-implemented identity seam. The library never reads tokens or claims
/// itself; the host maps its authentication (e.g. JWT NameIdentifier) to a
/// stable opaque user id. No foreign keys ever point at host user tables.
/// </summary>
public interface ICurrentUserProvider
{
    /// <summary>Stable opaque id for the current user. Throws if unauthenticated.</summary>
    string GetUserId();

    /// <summary>
    /// True when the current user may manage shared resources they do not own
    /// (edit/unshare/delete). Hosts typically map their admin role here.
    /// </summary>
    bool CanManageShared { get; }
}
