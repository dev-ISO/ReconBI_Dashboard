namespace ReconDashboards.Core.Abstractions;

/// <summary>Text attachment (CSV snapshots). Content is UTF-8 text.</summary>
public sealed record RcdEmailAttachment(string FileName, string ContentType, string Content);

/// <summary>One outbound message. Bodies are self-contained HTML (inline CSS only).</summary>
public sealed record RcdEmailMessage(
    IReadOnlyList<string> Recipients,
    string Subject,
    string HtmlBody,
    IReadOnlyList<RcdEmailAttachment> Attachments);

/// <summary>
/// Delivery seam for subscriptions and alerts. Hosts register SmtpEmailSender
/// (real SMTP) or FileEmailSink (local folder drop, used by the demo host when
/// no SMTP is configured). Implementations should throw on failure — the
/// scheduler logs and moves on; it never retries within a tick.
/// </summary>
public interface IRcdEmailSender
{
    Task SendAsync(RcdEmailMessage message, CancellationToken cancellationToken);
}
