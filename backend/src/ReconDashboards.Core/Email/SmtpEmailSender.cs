using System.Net;
using System.Net.Mail;
using System.Text;
using ReconDashboards.Core.Abstractions;

namespace ReconDashboards.Core.Email;

/// <summary>Bound from the host's "Rcd:Email" configuration section.</summary>
public sealed class RcdEmailOptions
{
    public string? Host { get; set; }
    public int Port { get; set; } = 25;
    public string From { get; set; } = "";
    public string? User { get; set; }
    public string? Password { get; set; }
    public bool UseSsl { get; set; }

    /// <summary>FileEmailSink drop folder (used when <see cref="Host"/> is empty).</summary>
    public string? DropFolder { get; set; }
}

/// <summary>
/// System.Net.Mail delivery. One SmtpClient per send — the scheduler sends
/// rarely and SmtpClient instances are not safe to share across concurrent
/// sends. Credentials only attach when a user is configured.
/// </summary>
public sealed class SmtpEmailSender(RcdEmailOptions options) : IRcdEmailSender
{
    public async Task SendAsync(RcdEmailMessage message, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(options.Host))
        {
            throw new InvalidOperationException("Rcd:Email:Host is not configured; cannot send via SMTP.");
        }

        if (string.IsNullOrWhiteSpace(options.From))
        {
            throw new InvalidOperationException("Rcd:Email:From is not configured; cannot send via SMTP.");
        }

        using var mail = new MailMessage
        {
            From = new MailAddress(options.From),
            Subject = message.Subject,
            Body = message.HtmlBody,
            IsBodyHtml = true,
        };

        foreach (var recipient in message.Recipients)
        {
            mail.To.Add(new MailAddress(recipient));
        }

        foreach (var attachment in message.Attachments)
        {
            var stream = new MemoryStream(Encoding.UTF8.GetBytes(attachment.Content));
            mail.Attachments.Add(new Attachment(stream, attachment.FileName, attachment.ContentType));
        }

        using var client = new SmtpClient(options.Host, options.Port)
        {
            EnableSsl = options.UseSsl,
            Credentials = string.IsNullOrEmpty(options.User)
                ? null
                : new NetworkCredential(options.User, options.Password),
        };

        await client.SendMailAsync(mail, cancellationToken);
    }
}
