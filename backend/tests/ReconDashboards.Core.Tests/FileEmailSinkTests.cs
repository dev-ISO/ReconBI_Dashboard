using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Email;

namespace ReconDashboards.Core.Tests;

public sealed class FileEmailSinkTests : IDisposable
{
    private readonly string _folder = Path.Combine(
        Path.GetTempPath(), "rcd-email-sink-tests-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_folder))
        {
            Directory.Delete(_folder, recursive: true);
        }
    }

    [Fact]
    public async Task WritesOneEmlFilePerMessageWithBodyAndAttachments()
    {
        var sink = new FileEmailSink(_folder);

        await sink.SendAsync(new RcdEmailMessage(
            ["ops@example.com", "boss@example.com"],
            "Ops Dashboard — dashboard snapshot",
            "<div>Hello <b>world</b></div>",
            [new RcdEmailAttachment("snapshot.csv", "text/csv", "region,total\nWest,120\n")]),
            CancellationToken.None);

        var file = Assert.Single(Directory.GetFiles(_folder, "*.eml"));
        var content = await File.ReadAllTextAsync(file);
        Assert.Contains("To: ops@example.com; boss@example.com", content, StringComparison.Ordinal);
        Assert.Contains("Subject: Ops Dashboard — dashboard snapshot", content, StringComparison.Ordinal);
        Assert.Contains("<b>world</b>", content, StringComparison.Ordinal);
        Assert.Contains("attachment: snapshot.csv (text/csv)", content, StringComparison.Ordinal);
        Assert.Contains("West,120", content, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SanitizesSubjectsIntoSafeFileNames()
    {
        var sink = new FileEmailSink(_folder);

        await sink.SendAsync(new RcdEmailMessage(
            ["a@example.com"], @"Alert x/y: value 10 crossed > 5?", "<p>body</p>", []),
            CancellationToken.None);

        var file = Assert.Single(Directory.GetFiles(_folder, "*.eml"));
        Assert.DoesNotContain("/", Path.GetFileName(file), StringComparison.Ordinal);
        Assert.DoesNotContain(">", Path.GetFileName(file), StringComparison.Ordinal);
    }

    [Fact]
    public async Task SecondMessageGetsItsOwnFile()
    {
        // Distinct subjects keep names unique even at the same timestamp.
        var sink = new FileEmailSink(_folder);
        await sink.SendAsync(new RcdEmailMessage(["a@example.com"], "one", "<p>1</p>", []), CancellationToken.None);
        await sink.SendAsync(new RcdEmailMessage(["a@example.com"], "two", "<p>2</p>", []), CancellationToken.None);

        Assert.Equal(2, Directory.GetFiles(_folder, "*.eml").Length);
    }

    [Fact]
    public async Task BinaryAttachmentsAreWrittenAsSiblingFilesNamedByTheirContentId()
    {
        // Chart PNGs are bytes, not text: dumping them into the .eml would be
        // unreadable, so the sink drops each one beside the message under its
        // cid — a developer can match "cid:tile-0-0@rcd" in the body to a file.
        var sink = new FileEmailSink(_folder);
        var png = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3 };

        await sink.SendAsync(new RcdEmailMessage(
            ["ops@example.com"],
            "Ops Dashboard — dashboard snapshot",
            "<img src=\"cid:tile-0-0@rcd\">",
            [
                new RcdEmailAttachment("snapshot.csv", "text/csv", "region,total\nWest,120\n"),
                new RcdEmailAttachment(
                    "tile-0-0.png", "image/png", Bytes: png, ContentId: "tile-0-0@rcd", Inline: true),
            ]),
            CancellationToken.None);

        var eml = await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(_folder, "*.eml")));
        // The text attachment still renders inline in the .eml, unchanged.
        Assert.Contains("attachment: snapshot.csv (text/csv)", eml, StringComparison.Ordinal);
        Assert.Contains("West,120", eml, StringComparison.Ordinal);
        // The binary one is announced with its disposition and its file name.
        Assert.Contains(
            "attachment: tile-0-0.png (image/png; inline cid:tile-0-0@rcd) ->", eml, StringComparison.Ordinal);

        var image = Assert.Single(Directory.GetFiles(_folder, "*.png"));
        Assert.Contains("tile-0-0", Path.GetFileName(image), StringComparison.Ordinal);
        Assert.Equal(png, await File.ReadAllBytesAsync(image)); // bytes survive verbatim
    }

    [Fact]
    public async Task ANonInlineBinaryAttachmentIsNamedByItsFileNameAndCarriesNoCidNote()
    {
        var sink = new FileEmailSink(_folder);

        await sink.SendAsync(new RcdEmailMessage(
            ["a@example.com"], "binary", "<p>body</p>",
            [new RcdEmailAttachment("report.pdf", "application/pdf", Bytes: [1, 2, 3])]),
            CancellationToken.None);

        var eml = await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(_folder, "*.eml")));
        Assert.Contains("attachment: report.pdf (application/pdf) ->", eml, StringComparison.Ordinal);
        Assert.DoesNotContain("inline cid:", eml, StringComparison.Ordinal);
        Assert.Single(Directory.GetFiles(_folder, "*.pdf"));
    }
}
