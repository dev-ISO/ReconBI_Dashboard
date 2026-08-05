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
}
