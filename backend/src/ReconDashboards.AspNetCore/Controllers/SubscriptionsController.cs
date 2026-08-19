using System.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using ReconDashboards.AspNetCore.Conventions;
using ReconDashboards.AspNetCore.Http;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Controllers;

/// <summary>
/// Dashboard snapshot subscriptions. View-policy users may manage their OWN
/// subscriptions, but only for dashboards they can read — the service enforces
/// dashboard visibility on create/update, and mutations of other users'
/// subscriptions require admin rights (CanManageShared). scope=all listing
/// and global opt-out management are admin-only at the service layer.
///
/// Two endpoints are [AllowAnonymous] BY DESIGN: unsubscribe and the open
/// pixel are reached from a mail client with no session — their HMAC token IS
/// the credential (see RcdSignedTokens). Every other action stays behind the
/// host's policies exactly as before.
/// </summary>
[Route("subscriptions")]
[RcdPolicySlot(RcdPolicySlot.View)]
public sealed class SubscriptionsController(SubscriptionService subscriptions) : RcdControllerBase
{
    /// <summary>Lists subscriptions: scope=mine (default) or scope=all (admin), optionally for one dashboard.</summary>
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? scope, [FromQuery] int? dashboardId, CancellationToken ct)
    {
        var result = await subscriptions.ListAsync(IsAllScope(scope), dashboardId, ct);
        return result.Succeeded
            ? Ok(result.Value!.Select(SchedulingDtoMapping.ToResponse).ToArray())
            : FromError(result.Error!);
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] SaveSubscriptionRequest request, CancellationToken ct)
    {
        var result = await subscriptions.CreateAsync(SchedulingDtoMapping.ToSaveRequest(request), ct);
        return result.Succeeded
            ? StatusCode(StatusCodes.Status201Created, SchedulingDtoMapping.ToResponse(result.Value!))
            : FromError(result.Error!);
    }

    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, [FromBody] SaveSubscriptionRequest request, CancellationToken ct)
    {
        var result = await subscriptions.UpdateAsync(id, SchedulingDtoMapping.ToSaveRequest(request), ct);
        return result.Succeeded ? Ok(SchedulingDtoMapping.ToResponse(result.Value!)) : FromError(result.Error!);
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, CancellationToken ct)
    {
        var result = await subscriptions.DeleteAsync(id, ct);
        return result.Succeeded ? NoContent() : FromError(result.Error!);
    }

    /// <summary>One-click pause/resume; owner or admin.</summary>
    [HttpPost("{id:int}/enabled")]
    public async Task<IActionResult> SetEnabled(int id, [FromBody] SetEnabledRequest request, CancellationToken ct)
    {
        var result = await subscriptions.SetEnabledAsync(id, request.Enabled, ct);
        return result.Succeeded ? Ok(SchedulingDtoMapping.ToResponse(result.Value!)) : FromError(result.Error!);
    }

    /// <summary>
    /// Starts a manual dispatch through the same pipeline as scheduled sends;
    /// 202 + the dispatch id to watch. One concurrent manual send per
    /// subscription — a second click gets 429 while the first still runs.
    /// </summary>
    [HttpPost("{id:int}/send-now")]
    public async Task<IActionResult> SendNow(int id, CancellationToken ct)
    {
        var result = await subscriptions.SendNowAsync(id, ct);
        return result.Succeeded
            ? StatusCode(StatusCodes.Status202Accepted, new SendNowResponse(result.Value))
            : FromError(result.Error!);
    }

    /// <summary>Dispatch history with per-recipient status/attempts/errors/opens; owner or admin.</summary>
    [HttpGet("{id:int}/dispatches")]
    public async Task<IActionResult> ListDispatches(int id, [FromQuery] int limit = 20, CancellationToken ct = default)
    {
        var result = await subscriptions.ListDispatchesAsync(id, limit, ct);
        return result.Succeeded
            ? Ok(result.Value!.Select(SchedulingDtoMapping.ToResponse).ToArray())
            : FromError(result.Error!);
    }

    // ------------------------------------------------------------- opt-outs

    /// <summary>Per-subscription opt-outs; owner or admin.</summary>
    [HttpGet("{id:int}/optouts")]
    public async Task<IActionResult> ListOptOuts(int id, CancellationToken ct)
    {
        var result = await subscriptions.ListOptOutsAsync(id, ct);
        return result.Succeeded
            ? Ok(result.Value!.Select(SchedulingDtoMapping.ToResponse).ToArray())
            : FromError(result.Error!);
    }

    /// <summary>Clears one opt-out so the address receives this subscription again; idempotent.</summary>
    [HttpDelete("{id:int}/optouts/{email}")]
    public async Task<IActionResult> ClearOptOut(int id, string email, CancellationToken ct)
    {
        var result = await subscriptions.ClearOptOutAsync(id, email, ct);
        return result.Succeeded ? NoContent() : FromError(result.Error!);
    }

    /// <summary>Global suppressions (every subscription email); admin-only.</summary>
    [HttpGet("optouts/global")]
    public async Task<IActionResult> ListGlobalOptOuts(CancellationToken ct)
    {
        var result = await subscriptions.ListGlobalOptOutsAsync(ct);
        return result.Succeeded
            ? Ok(result.Value!.Select(SchedulingDtoMapping.ToResponse).ToArray())
            : FromError(result.Error!);
    }

    /// <summary>Clears one global suppression; idempotent; admin-only.</summary>
    [HttpDelete("optouts/global/{email}")]
    public async Task<IActionResult> ClearGlobalOptOut(string email, CancellationToken ct)
    {
        var result = await subscriptions.ClearGlobalOptOutAsync(email, ct);
        return result.Succeeded ? NoContent() : FromError(result.Error!);
    }

    // ---------------------------- anonymous, token-authenticated endpoints

    /// <summary>
    /// Minimal self-contained confirm page (a mail client's browser hop —
    /// no app session, no SPA). Offers BOTH scopes: this subscription only,
    /// or all dashboard emails. Invalid/foreign tokens and unset secrets all
    /// render the same 404 page — nothing to probe.
    /// </summary>
    [HttpGet("unsubscribe")]
    [AllowAnonymous]
    public async Task<IActionResult> UnsubscribePage([FromQuery] string? token, CancellationToken ct)
    {
        var context = await subscriptions.ReadUnsubscribeTokenAsync(token, ct);
        if (context is null)
        {
            return Page(HtmlPages.InvalidLink(), StatusCodes.Status404NotFound);
        }

        return Page(HtmlPages.Confirm(context, token!));
    }

    /// <summary>Records the opt-out the confirm page chose (form field scope: "one" | "all").</summary>
    [HttpPost("unsubscribe")]
    [AllowAnonymous]
    public async Task<IActionResult> Unsubscribe(
        [FromQuery] string? token, [FromForm] string? scope, CancellationToken ct)
    {
        var global = string.Equals(scope, "all", StringComparison.OrdinalIgnoreCase);
        var recorded = await subscriptions.RecordUnsubscribeAsync(token, global, ct);
        return recorded
            ? Page(HtmlPages.Done(global))
            : Page(HtmlPages.InvalidLink(), StatusCodes.Status404NotFound);
    }

    /// <summary>
    /// 1×1 open-tracking pixel. ALWAYS returns the GIF — invalid tokens are
    /// silently ignored so mail clients never show a broken image and the
    /// endpoint leaks nothing. Accuracy is inherently approximate (image
    /// proxies, blocked images, Cloudflare Access) — surfaced in the UI as
    /// "Opened (approximate)".
    /// </summary>
    [HttpGet("open")]
    [AllowAnonymous]
    public async Task<IActionResult> OpenPixel([FromQuery] string? token, CancellationToken ct)
    {
        await subscriptions.RecordOpenAsync(token, ct);
        Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
        return File(HtmlPages.TransparentGif, "image/gif");
    }

    private static bool IsAllScope(string? scope) =>
        string.Equals(scope, "all", StringComparison.OrdinalIgnoreCase);

    private ContentResult Page(string html, int statusCode = StatusCodes.Status200OK) =>
        new() { Content = html, ContentType = "text/html; charset=utf-8", StatusCode = statusCode };

    /// <summary>
    /// The three unsubscribe pages, inline-styled and dependency-free: they
    /// must render from a bare API response with no SPA, no CSS pipeline, and
    /// work in whatever browser a mail client opens.
    /// </summary>
    private static class HtmlPages
    {
        /// <summary>1×1 transparent GIF (the classic 43-byte pixel).</summary>
        public static readonly byte[] TransparentGif =
            Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");

        private const string Shell =
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
            "<title>Dashboard emails</title></head>" +
            "<body style=\"margin:0;background:#f3f4f6;font-family:Segoe UI,Arial,sans-serif;color:#1f2937;\">" +
            "<div style=\"max-width:420px;margin:48px auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px 28px;\">{0}</div>" +
            "</body></html>";

        public static string InvalidLink() => string.Format(
            Shell,
            "<div style=\"font-size:17px;font-weight:600;margin-bottom:8px;\">This link is no longer valid</div>" +
            "<div style=\"font-size:13px;color:#6b7280;\">The unsubscribe link could not be verified. " +
            "If you still receive unwanted dashboard emails, use the link in a newer email or contact an administrator.</div>");

        public static string Confirm(UnsubscribeContext context, string token)
        {
            var email = WebUtility.HtmlEncode(context.Email);
            var reportName = context.SubscriptionName is { } name
                ? "“" + WebUtility.HtmlEncode(name) + "”"
                : "this report";
            var action = "unsubscribe?token=" + Uri.EscapeDataString(token);

            var oneButton = context.AlreadyOptedOut
                ? "<div style=\"font-size:13px;color:#059669;margin:12px 0;\">You are already unsubscribed from this report.</div>"
                : $"<form method=\"post\" action=\"{action}\" style=\"margin:12px 0;\">" +
                  "<input type=\"hidden\" name=\"scope\" value=\"one\">" +
                  $"<button type=\"submit\" style=\"width:100%;padding:10px 12px;font-size:14px;font-weight:600;color:#ffffff;background:#374151;border:0;border-radius:6px;cursor:pointer;\">Unsubscribe from {reportName}</button>" +
                  "</form>";

            var allButton = context.AlreadyGlobal
                ? "<div style=\"font-size:13px;color:#059669;margin:12px 0;\">You are already unsubscribed from all dashboard emails.</div>"
                : $"<form method=\"post\" action=\"{action}\" style=\"margin:12px 0;\">" +
                  "<input type=\"hidden\" name=\"scope\" value=\"all\">" +
                  "<button type=\"submit\" style=\"width:100%;padding:10px 12px;font-size:14px;font-weight:600;color:#b91c1c;background:#ffffff;border:1px solid #fca5a5;border-radius:6px;cursor:pointer;\">Unsubscribe from ALL dashboard emails</button>" +
                  "</form>";

            return string.Format(
                Shell,
                "<div style=\"font-size:17px;font-weight:600;margin-bottom:8px;\">Unsubscribe</div>" +
                $"<div style=\"font-size:13px;color:#6b7280;margin-bottom:16px;\">{email} receives {reportName}.</div>" +
                oneButton + allButton +
                "<div style=\"font-size:11px;color:#9ca3af;margin-top:16px;\">A subscription owner or administrator can re-invite you later.</div>");
        }

        public static string Done(bool global) => string.Format(
            Shell,
            "<div style=\"font-size:17px;font-weight:600;margin-bottom:8px;\">You're unsubscribed</div>" +
            "<div style=\"font-size:13px;color:#6b7280;\">" +
            (global
                ? "This address will no longer receive ANY dashboard subscription emails."
                : "This address will no longer receive this report. Other dashboard emails are unaffected.") +
            "</div>");
    }
}
