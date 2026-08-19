namespace ReconDashboards.Core.Abstractions;

/// <summary>
/// One attachment. Exactly one of <see cref="Content"/> (UTF-8 text — CSV
/// snapshots) or <see cref="Bytes"/> (binary — inline chart PNGs) carries the
/// payload; senders resolve the bytes as Bytes ?? UTF8(Content ?? "").
/// <see cref="Inline"/> + <see cref="ContentId"/> mark a cid-referenced inline
/// image (&lt;img src="cid:{ContentId}"&gt; in the HTML body); transports must
/// emit Content-ID and an inline content disposition for those.
/// </summary>
public sealed record RcdEmailAttachment(
    string FileName,
    string ContentType,
    string? Content = null,
    byte[]? Bytes = null,
    string? ContentId = null,
    bool Inline = false);

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
