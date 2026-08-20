using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Controllers;

/// <summary>
/// api/rcd/v1/user-settings — the signed-in caller's own private preference
/// document. Two verbs, no id: GET reads it, PUT replaces it whole.
///
/// VIEW policy slot, not Author: this is self-service, exactly like PUT
/// dashboards/{id} — a plain viewer must be able to keep their own preferences,
/// and none of it grants any access to content. There is no admin variant and
/// no route that names another user, so "read someone else's settings" is not
/// an endpoint that exists.
/// </summary>
[Route("user-settings")]
[RcdPolicySlot(RcdPolicySlot.View)]
public sealed class UserSettingsController(UserSettingsService settings) : RcdControllerBase
{
    /// <summary>
    /// The caller's document, or the versioned empty default. Never 404: a
    /// first-time caller is not an error, and every client would have to treat
    /// that 404 as success anyway.
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var result = await settings.GetAsync(ct);
        return result.Succeeded ? Ok(ToResponse(result.Value!)) : FromError(result.Error!);
    }

    /// <summary>
    /// Whole-document replace (last-write-wins). Bound as a raw JsonElement so
    /// a body that is not a JSON object fails as a clean 400 from this
    /// endpoint's own contract rather than as an MVC binding error.
    /// </summary>
    [HttpPut]
    public async Task<IActionResult> Put([FromBody] JsonElement body, CancellationToken ct)
    {
        if (ToSettingsJson(body) is not { } settingsJson)
        {
            return FromError(new ServiceError(
                ServiceErrorKind.BadRequest, "rcd.user_settings.invalid",
                "PUT user-settings takes a JSON object body: { settings: { … } }."));
        }

        var result = await settings.ReplaceAsync(settingsJson, ct);
        return result.Succeeded ? Ok(ToResponse(result.Value!)) : FromError(result.Error!);
    }

    /// <summary>
    /// Unwraps the enveloped body <c>{ "settings": { … } }</c>. Strictness
    /// doctrine, same as PATCH dashboards/{id}/meta: an unknown or mistyped
    /// field is REJECTED, not ignored, so a typo'd envelope fails loudly
    /// instead of silently persisting nothing (and a preference document that
    /// silently never saved is the worst version of this feature).
    /// </summary>
    private static string? ToSettingsJson(JsonElement body)
    {
        if (body.ValueKind is not JsonValueKind.Object)
        {
            return null;
        }

        string? settingsJson = null;
        foreach (var property in body.EnumerateObject())
        {
            if (property.Name != "settings" || property.Value.ValueKind is not JsonValueKind.Object)
            {
                return null;
            }

            settingsJson = property.Value.GetRawText();
        }

        return settingsJson;
    }

    private static UserSettingsResponse ToResponse(UserSettingsDocument document) =>
        new(document.Settings, document.UpdatedAtUtc);
}
