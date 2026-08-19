using System.Text;
using ReconDashboards.Core.Abstractions;

namespace ReconDashboards.Core.Email;

/// <summary>
/// Local-development delivery: writes one .eml-ish file per message to a
/// folder so subscriptions and alerts are fully testable without SMTP. The
/// demo host registers this automatically when Rcd:Email:Host is not set.
/// </summary>
public sealed class FileEmailSink(string folder, TimeProvider? timeProvider = null) : IRcdEmailSender
{
    private readonly TimeProvider _clock = timeProvider ?? TimeProvider.System;

    public string Folder { get; } = folder;

    public async Task SendAsync(RcdEmailMessage message, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Folder);

        var now = _clock.GetUtcNow().UtcDateTime;
        var safeSubject = Sanitize(message.Subject);
        var path = Path.Combine(Folder, $"{now:yyyyMMdd-HHmmss-fff}-{safeSubject}.eml");

        var builder = new StringBuilder();
        builder.Append("To: ").AppendLine(string.Join("; ", message.Recipients));
        builder.Append("Subject: ").AppendLine(message.Subject);
        builder.Append("Date: ").AppendLine(now.ToString("R"));
        builder.AppendLine("Content-Type: text/html; charset=utf-8");
        builder.AppendLine();
        builder.AppendLine(message.HtmlBody);

        foreach (var attachment in message.Attachments)
        {
            builder.AppendLine();
            if (attachment.Bytes is { } bytes)
            {
                // Binary attachments (inline chart PNGs) go to sibling files —
                // named by ContentId when present so a cid in the HTML body can
                // be matched to its image on disk.
                var suffix = Sanitize(attachment.ContentId ?? attachment.FileName);
                var binaryPath = Path.Combine(
                    Folder,
                    $"{now:yyyyMMdd-HHmmss-fff}-{safeSubject}-{suffix}{Path.GetExtension(attachment.FileName)}");
                await File.WriteAllBytesAsync(binaryPath, bytes, cancellationToken);
                var inlineNote = attachment.Inline ? $"; inline cid:{attachment.ContentId}" : "";
                builder.AppendLine(
                    $"--- attachment: {attachment.FileName} ({attachment.ContentType}{inlineNote}) -> {Path.GetFileName(binaryPath)} ---");
            }
            else
            {
                builder.AppendLine($"--- attachment: {attachment.FileName} ({attachment.ContentType}) ---");
                builder.AppendLine(attachment.Content);
            }
        }

        await File.WriteAllTextAsync(path, builder.ToString(), Encoding.UTF8, cancellationToken);
    }

    private static string Sanitize(string subject)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var chars = subject.Select(c => invalid.Contains(c) || c is ' ' ? '-' : c).ToArray();
        var name = new string(chars);
        return name.Length > 60 ? name[..60] : name;
    }
}
