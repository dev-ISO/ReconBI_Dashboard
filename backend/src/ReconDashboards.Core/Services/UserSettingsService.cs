using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Options;
using ReconDashboards.Core.Persistence;

namespace ReconDashboards.Core.Services;

/// <summary>
/// One user's private preference document plus the instant it was last written
/// (null for a caller who has never saved — the empty default).
/// </summary>
public sealed record UserSettingsDocument(JsonElement Settings, DateTime? UpdatedAtUtc);

/// <summary>
/// Per-user settings store: read/replace ONE row of <c>rcd_user_settings</c>,
/// always the caller's own.
///
/// SERVER-OPAQUE BY DESIGN. The document is parsed and re-serialized and
/// nothing else — no schema, no key allow-list, no interpretation (the same
/// contract as the tracker host's NormalizeStoredSettingsJson, and the same
/// contract dashboard layouts already have here). That is what lets later
/// preference waves add a top-level section without a migration or a server
/// deploy. The reserved sections are, by convention only:
/// <code>{ "version": 1, "measures": [...], "fieldList": { ... } }</code>
/// The only server-enforced invariants are: valid JSON, an object at the root,
/// bounded depth, and <see cref="RcdLimits.MaxUserSettingsBytes"/>.
///
/// ISOLATION. The user id is NEVER accepted from the wire — there is no id
/// segment on the route and no id field on the body. Every read and every write
/// derives it from <see cref="ICurrentUserProvider.GetUserId"/> and uses it as
/// the primary key, so one caller cannot address another caller's row at all.
/// </summary>
public sealed class UserSettingsService(
    ReconDashboardsDbContext db,
    ICurrentUserProvider currentUser,
    ReconDashboardsOptions options,
    TimeProvider clock)
{
    /// <summary>
    /// What a caller with no stored row gets. Versioned from the start so a
    /// future document migration has something to branch on; the two reserved
    /// sections are absent rather than empty, because "absent" is what every
    /// consumer must already tolerate on an older document.
    /// </summary>
    internal const string EmptyDocumentJson = """{"version":1}""";

    /// <summary>Matches the dashboard-layout parse budget (DashboardService.ValidateRequest).</summary>
    private const int MaxDocumentDepth = 32;

    /// <summary>
    /// The caller's document, or the empty default — NEVER a 404: "I have no
    /// preferences yet" and "I have these preferences" are the same state to
    /// every consumer, and a 404 would make first use an error path.
    ///
    /// An unauthenticated caller reads the empty default too. The identity seam
    /// THROWS for an anonymous caller (its documented contract), and this
    /// endpoint sits in the View slot, which a host may open up; degrading the
    /// way MetaController does keeps a read from turning into a 500. Such a
    /// caller has no row and never will — see <see cref="ReplaceAsync"/>.
    /// </summary>
    public async Task<ServiceResult<UserSettingsDocument>> GetAsync(CancellationToken ct)
    {
        if (TryGetUserId() is not { } userId)
        {
            return ServiceResult<UserSettingsDocument>.Ok(EmptyDocument());
        }

        var record = await db.UserSettings.AsNoTracking()
            .FirstOrDefaultAsync(s => s.UserId == userId, ct);

        if (record is null)
        {
            return ServiceResult<UserSettingsDocument>.Ok(EmptyDocument());
        }

        return ServiceResult<UserSettingsDocument>.Ok(
            new UserSettingsDocument(Parse(record.SettingsJson), record.UpdatedAtUtc));
    }

    /// <summary>
    /// Replaces the caller's whole document — last-write-wins, no merge. The
    /// document is a single private blob written by one user's tabs, so a field
    /// merge would only invent conflicts that the client (which holds the whole
    /// document anyway) already resolves.
    ///
    /// Unlike the read, an unidentified caller is REFUSED rather than silently
    /// accepted: without an id there is no row to write, and answering 200 to a
    /// save that stored nothing is the kind of lie that surfaces days later as
    /// "my preferences keep resetting".
    /// </summary>
    public async Task<ServiceResult<UserSettingsDocument>> ReplaceAsync(
        string settingsJson, CancellationToken ct)
    {
        if (TryGetUserId() is not { } userId)
        {
            return ServiceResult<UserSettingsDocument>.Fail(
                ServiceErrorKind.Forbidden, "rcd.user_settings.unidentified",
                "Personal settings require a signed-in user.");
        }

        if (Normalize(settingsJson) is not { } normalized)
        {
            return ServiceResult<UserSettingsDocument>.Fail(
                ServiceErrorKind.BadRequest, "rcd.user_settings.invalid",
                "Settings must be a JSON object.");
        }

        // Cap the STORED bytes, i.e. after re-serialization: the client's
        // whitespace is not the user's data, and the number the client is told
        // on /meta must be the number the server actually applies.
        if (Encoding.UTF8.GetByteCount(normalized) > options.Limits.MaxUserSettingsBytes)
        {
            return ServiceResult<UserSettingsDocument>.Fail(
                ServiceErrorKind.LimitExceeded, "rcd.limit.user_settings_size",
                $"Personal settings exceed {options.Limits.MaxUserSettingsBytes / 1024} KB.");
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var record = await db.UserSettings.FirstOrDefaultAsync(s => s.UserId == userId, ct);
        if (record is null)
        {
            record = new UserSettingsRecord { UserId = userId };
            db.UserSettings.Add(record);
        }

        record.SettingsJson = normalized;
        record.UpdatedAtUtc = now;
        await db.SaveChangesAsync(ct);

        return ServiceResult<UserSettingsDocument>.Ok(
            new UserSettingsDocument(Parse(normalized), now));
    }

    /// <summary>
    /// The identity seam throws for an unauthenticated caller (ICurrentUserProvider
    /// documents exactly that). Catch it here, in the ONE place both endpoints
    /// share, exactly as MetaController does — an anonymous request must degrade,
    /// never 500. A blank id is treated as no id for the same reason: it would
    /// otherwise become a shared row every anonymous caller could read.
    /// </summary>
    private string? TryGetUserId()
    {
        try
        {
            var userId = currentUser.GetUserId();
            return string.IsNullOrWhiteSpace(userId) ? null : userId;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static UserSettingsDocument EmptyDocument() =>
        new(Parse(EmptyDocumentJson), UpdatedAtUtc: null);

    private static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = MaxDocumentDepth });
        return document.RootElement.Clone();
    }

    /// <summary>
    /// Parse + re-serialize, the whole of the server's involvement in the
    /// document's shape (the host's NormalizeStoredSettingsJson pattern).
    /// Returns null for anything that is not a JSON object — including a bare
    /// array or scalar, which would break every consumer's "read section by
    /// key" assumption on the next GET.
    /// </summary>
    private static string? Normalize(string? settingsJson)
    {
        if (string.IsNullOrWhiteSpace(settingsJson))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(
                settingsJson, new JsonDocumentOptions { MaxDepth = MaxDocumentDepth });
            return document.RootElement.ValueKind == JsonValueKind.Object
                ? JsonSerializer.Serialize(document.RootElement)
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
