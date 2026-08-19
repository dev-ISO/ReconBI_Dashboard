using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Core.Services;

/// <summary>
/// THE dashboard authorization rules, extracted from <see cref="DashboardService"/>
/// so the ops path (<see cref="DashboardOpService"/>) enforces literally the same
/// code instead of a copy that could drift. Everything here is pure over
/// (record, caller identity, share row) — no I/O — which is what makes the
/// per-op re-check cheap enough to run on every keystroke-coalesced op.
/// </summary>
internal static class DashboardAccessRules
{
    /// <summary>Built-in (seeded) content is read-only for everyone through the API.</summary>
    internal static bool IsSystem(DashboardRecord record, string? systemOwnerUserId) =>
        !string.IsNullOrEmpty(systemOwnerUserId)
        && string.Equals(record.OwnerUserId, systemOwnerUserId, StringComparison.Ordinal);

    /// <summary>Visibility: owner OR published (IsShared) OR a named share row.</summary>
    internal static bool IsVisibleTo(DashboardRecord record, string userId, DashboardShareRecord? share) =>
        record.OwnerUserId == userId || record.IsShared || share is not null;

    /// <summary>THE single place caller access is computed from a record + share row.</summary>
    internal static DashboardAccess ComputeAccess(
        DashboardRecord record,
        string userId,
        bool canManageShared,
        string? systemOwnerUserId,
        DashboardShareRecord? share)
    {
        var isOwner = record.OwnerUserId == userId;
        var viaShare = !isOwner && share is not null;
        var viaPublish = !isOwner && share is null && record.IsShared;

        if (IsSystem(record, systemOwnerUserId))
        {
            // Built-in content is read-only for everyone, admins included.
            return new DashboardAccess(isOwner, false, false, false, false, false, false, viaShare, viaPublish);
        }

        var full = isOwner || canManageShared;
        var canEditLayout = full || share?.CanEditLayout == true;
        var canManagePages = full || share?.CanManagePages == true;
        var canEditCharts = full || share?.CanEditCharts == true;
        var canMoveTiles = full || share?.CanMoveTiles == true;
        var canDeleteContent = full || share?.CanDeleteContent == true;
        return new DashboardAccess(
            isOwner,
            full || canEditLayout || canManagePages || canEditCharts || canMoveTiles || canDeleteContent,
            canEditLayout, canManagePages, canEditCharts, canMoveTiles, canDeleteContent,
            viaShare, viaPublish);
    }

    /// <summary>
    /// Maps raised change classes to the share flags that must cover them.
    /// Beyond the three class flags: geometry rides CanMoveTiles; tile/page
    /// REMOVALS additionally require CanDeleteContent (deletion = class flag
    /// AND delete flag, so the delete right narrows rather than widens); chart
    /// retitles have NO covering flag — they are owner/admin-only, so any
    /// rename in a grantee change is always denied here. Save path and ops
    /// path both call this with a differ-produced summary, which is what makes
    /// "an op cannot bypass the grantee gate" true by construction.
    /// </summary>
    internal static List<string> MissingPermissions(LayoutChangeSummary summary, DashboardShareRecord share)
    {
        var missing = new List<string>();
        if (summary.LayoutChanged && !share.CanEditLayout)
        {
            missing.Add("layout changes");
        }

        if (summary.PagesChanged && !share.CanManagePages)
        {
            missing.Add("page changes");
        }

        if (summary.ChartsChanged && !share.CanEditCharts)
        {
            missing.Add("chart changes");
        }

        if (summary.GeometryChanged && !share.CanMoveTiles)
        {
            missing.Add("moving or resizing tiles");
        }

        if (summary.HasRemovals && !share.CanDeleteContent)
        {
            missing.Add("removing tiles or pages");
        }

        if (summary.ChartsRenamed.Count > 0)
        {
            missing.Add("renaming charts (owner only)");
        }

        return missing;
    }

    // ------------------- shared error factories (stable codes) -------------------
    // Kept next to the rules so the ops path and the save path can never answer
    // the same situation with different codes.

    internal static ServiceError NotFoundError(int id) =>
        new(ServiceErrorKind.NotFound, "rcd.dashboard.not_found",
            $"Dashboard {id} does not exist or is not visible to you.");

    internal static ServiceError SystemReadOnlyError() =>
        new(ServiceErrorKind.Forbidden, "rcd.dashboard.system_readonly",
            "This is a built-in item managed by the application. Make a copy to edit it.");

    internal static ServiceError EditForbiddenError() =>
        new(ServiceErrorKind.Forbidden, "rcd.dashboard.forbidden",
            "Only the owner, an administrator, or a user it was shared with can edit this dashboard.");

    internal static ServiceError PermissionDeniedError(IReadOnlyList<string> missing) =>
        new(ServiceErrorKind.Forbidden, "rcd.dashboard.permission_denied",
            $"Your access does not allow {string.Join(" or ", missing)}.");
}
