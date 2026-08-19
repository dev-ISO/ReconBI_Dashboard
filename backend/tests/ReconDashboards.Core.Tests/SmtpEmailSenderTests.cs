using System.Text;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Email;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// SMTP MESSAGE CONSTRUCTION only — no server, no socket. Whether a chart PNG
/// shows up inside the email body or as a downloadable file at the bottom comes
/// down to two MIME details (Content-ID and an inline content disposition), and
/// those are worth pinning: the transport half is System.Net.Mail's problem,
/// this half is ours.
/// </summary>
public class SmtpEmailSenderTests
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];

    private static RcdEmailMessage Message(params RcdEmailAttachment[] attachments) =>
        new(["ops@example.com", "boss@example.com"], "Ops Dashboard — dashboard snapshot",
            "<div><img src=\"cid:tile-0-0@rcd\"></div>", attachments);

    [Fact]
    public void TheEnvelopeCarriesEveryRecipientAndAnHtmlBody()
    {
        using var mail = SmtpEmailSender.BuildMailMessage("noreply@example.com", Message());

        Assert.Equal("noreply@example.com", mail.From!.Address);
        Assert.Equal(["ops@example.com", "boss@example.com"], mail.To.Select(t => t.Address));
        Assert.Equal("Ops Dashboard — dashboard snapshot", mail.Subject);
        Assert.True(mail.IsBodyHtml);
        Assert.Contains("cid:tile-0-0@rcd", mail.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void AnInlineImageGetsItsContentIdAndAnInlineDisposition()
    {
        using var mail = SmtpEmailSender.BuildMailMessage(
            "noreply@example.com",
            Message(new RcdEmailAttachment(
                "tile-0-0.png", "image/png", Bytes: Png, ContentId: "tile-0-0@rcd", Inline: true)));

        var attachment = Assert.Single(mail.Attachments);
        Assert.Equal("tile-0-0.png", attachment.Name);
        Assert.Equal("image/png", attachment.ContentType.MediaType);
        // Without BOTH of these the image renders as a separate download, not
        // in place of the <img cid:...> in the body.
        Assert.Equal("tile-0-0@rcd", attachment.ContentId);
        Assert.True(attachment.ContentDisposition!.Inline);
        Assert.Equal(Png, ReadAll(attachment));
    }

    [Fact]
    public void TheCsvAttachmentStillTravelsAsUtf8TextAndStaysADownload()
    {
        const string csv = "region,total\nWest,120\n";
        using var mail = SmtpEmailSender.BuildMailMessage(
            "noreply@example.com",
            Message(new RcdEmailAttachment("snapshot.csv", "text/csv", csv)));

        var attachment = Assert.Single(mail.Attachments);
        Assert.Equal("text/csv", attachment.ContentType.MediaType);
        Assert.False(attachment.ContentDisposition!.Inline);
        Assert.Equal(csv, Encoding.UTF8.GetString(ReadAll(attachment)));
        // System.Net.Mail mints a GUID Content-ID for any attachment that lacks
        // one; what matters is that it is not a cid the BODY references.
        Assert.DoesNotContain("@rcd", attachment.ContentId, StringComparison.Ordinal);
    }

    [Fact]
    public void BytesWinOverContentAndAnEmptyAttachmentIsNotAnError()
    {
        using var mail = SmtpEmailSender.BuildMailMessage(
            "noreply@example.com",
            Message(
                new RcdEmailAttachment("both.bin", "application/octet-stream", "ignored-text", Png),
                new RcdEmailAttachment("empty.txt", "text/plain")));

        Assert.Equal(Png, ReadAll(mail.Attachments[0]));
        Assert.Empty(ReadAll(mail.Attachments[1]));
    }

    [Fact]
    public void AMixedMessageKeepsTheCsvAndEveryChartImageInOrder()
    {
        // The dispatcher builds exactly this shape for a csv-format
        // subscription in charts mode: CSV first, then one image per tile.
        using var mail = SmtpEmailSender.BuildMailMessage(
            "noreply@example.com",
            Message(
                new RcdEmailAttachment("snapshot.csv", "text/csv", "a,b\n1,2\n"),
                new RcdEmailAttachment("tile-0-0.png", "image/png", Bytes: Png, ContentId: "tile-0-0@rcd", Inline: true),
                new RcdEmailAttachment("tile-0-1.png", "image/png", Bytes: Png, ContentId: "tile-0-1@rcd", Inline: true)));

        Assert.Equal(3, mail.Attachments.Count);
        Assert.Equal(
            ["snapshot.csv", "tile-0-0.png", "tile-0-1.png"],
            mail.Attachments.Select(a => a.Name));
        Assert.Equal(2, mail.Attachments.Count(a => a.ContentDisposition!.Inline));
        // cids are unique per tile, so the body's <img> tags never cross-wire.
        Assert.Equal(
            ["tile-0-0@rcd", "tile-0-1@rcd"],
            mail.Attachments.Where(a => a.ContentDisposition!.Inline).Select(a => a.ContentId));
    }

    private static byte[] ReadAll(System.Net.Mail.Attachment attachment)
    {
        using var buffer = new MemoryStream();
        attachment.ContentStream.Position = 0;
        attachment.ContentStream.CopyTo(buffer);
        return buffer.ToArray();
    }
}
