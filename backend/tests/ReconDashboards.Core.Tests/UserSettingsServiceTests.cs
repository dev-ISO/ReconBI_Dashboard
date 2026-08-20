using System.Text.Json;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Services;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// The per-user settings store (Fields wave 1). Two contracts are load-bearing
/// and everything else follows from them:
///  1. a caller can only ever reach their OWN row — the id is never on the wire,
///     it comes from ICurrentUserProvider and IS the primary key;
///  2. the document is SERVER-OPAQUE — parsed and re-serialized, never
///     interpreted — so later waves add a section without a migration.
/// </summary>
public class UserSettingsServiceTests : IDisposable
{
    private readonly ServiceTestHarness _harness = new();
    private readonly UserSettingsService _service;

    public UserSettingsServiceTests()
    {
        _service = _harness.CreateUserSettingsService();
    }

    public void Dispose() => _harness.Dispose();

    [Fact]
    public async Task FirstRead_ReturnsTheVersionedEmptyDocument_NotAnError()
    {
        var result = await _service.GetAsync(CancellationToken.None);

        Assert.True(result.Succeeded);
        Assert.Equal(JsonValueKind.Object, result.Value!.Settings.ValueKind);
        Assert.Equal(1, result.Value.Settings.GetProperty("version").GetInt32());
        Assert.Null(result.Value.UpdatedAtUtc);
    }

    [Fact]
    public async Task ReplaceThenGet_RoundTripsTheWholeDocument()
    {
        const string document = """
            {"version":1,"fieldList":{"grouping":"type","expanded":["#measures/Finance"]},
             "measures":[{"id":"m1","name":"My Total"}]}
            """;

        var saved = await _service.ReplaceAsync(document, CancellationToken.None);
        Assert.True(saved.Succeeded);
        Assert.NotNull(saved.Value!.UpdatedAtUtc);

        var fetched = await _service.GetAsync(CancellationToken.None);

        Assert.True(fetched.Succeeded);
        var settings = fetched.Value!.Settings;
        Assert.Equal("type", settings.GetProperty("fieldList").GetProperty("grouping").GetString());
        Assert.Equal("My Total", settings.GetProperty("measures")[0].GetProperty("name").GetString());
        Assert.Equal(saved.Value.UpdatedAtUtc, fetched.Value.UpdatedAtUtc);
    }

    [Fact]
    public async Task SecondReplace_ReplacesWholesale_ItNeverMerges()
    {
        await _service.ReplaceAsync(
            """{"version":1,"fieldList":{"grouping":"table"},"measures":[{"id":"m1"}]}""",
            CancellationToken.None);

        await _service.ReplaceAsync("""{"version":1,"fieldList":{"grouping":"type"}}""", CancellationToken.None);

        var fetched = await _service.GetAsync(CancellationToken.None);
        var settings = fetched.Value!.Settings;
        Assert.Equal("type", settings.GetProperty("fieldList").GetProperty("grouping").GetString());
        // measures is GONE: the client owns the whole document, last write wins.
        Assert.False(settings.TryGetProperty("measures", out _));
        Assert.Single(_harness.Db.UserSettings);
    }

    [Fact]
    public async Task UnknownSections_SurviveUntouched_SoALaterWaveNeedsNoMigration()
    {
        // Nothing in this build knows what "someFutureWave" is; that is the point.
        const string document = """{"version":1,"someFutureWave":{"nested":[1,2,{"deep":true}]}}""";

        await _service.ReplaceAsync(document, CancellationToken.None);
        var fetched = await _service.GetAsync(CancellationToken.None);

        var future = fetched.Value!.Settings.GetProperty("someFutureWave");
        Assert.True(future.GetProperty("nested")[2].GetProperty("deep").GetBoolean());
    }

    [Fact]
    public async Task StoredJson_IsReSerialized_NotEchoed()
    {
        // The server's ONLY involvement in the shape: parse + re-serialize. The
        // caller's whitespace is not the user's data, so it never counts toward
        // the byte cap and never reaches the column.
        await _service.ReplaceAsync("{\n  \"version\" : 1,\n  \"a\" :  1\n}", CancellationToken.None);

        var stored = Assert.Single(_harness.Db.UserSettings);
        Assert.Equal("""{"version":1,"a":1}""", stored.SettingsJson);
    }

    [Theory]
    [InlineData("not json at all")]
    [InlineData("[1,2,3]")]
    [InlineData("\"a string\"")]
    [InlineData("42")]
    [InlineData("")]
    public async Task NonObjectOrInvalidDocuments_AreRejected(string document)
    {
        var result = await _service.ReplaceAsync(document, CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal(ServiceErrorKind.BadRequest, result.Error!.Kind);
        Assert.Equal("rcd.user_settings.invalid", result.Error.Code);
        Assert.Empty(_harness.Db.UserSettings);
    }

    [Fact]
    public async Task OverTheByteCap_IsRejected_AndLeavesTheStoredDocumentIntact()
    {
        await _service.ReplaceAsync("""{"version":1,"keep":"me"}""", CancellationToken.None);
        _harness.Options.Limits.MaxUserSettingsBytes = 120;

        var padding = new string('x', 500);
        var result = await _service.ReplaceAsync(
            "{\"version\":1,\"fieldList\":{\"pad\":\"" + padding + "\"}}", CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal(ServiceErrorKind.LimitExceeded, result.Error!.Kind);
        Assert.Equal("rcd.limit.user_settings_size", result.Error.Code);

        var fetched = await _service.GetAsync(CancellationToken.None);
        Assert.Equal("me", fetched.Value!.Settings.GetProperty("keep").GetString());
    }

    [Fact]
    public async Task ADocumentThatOnlyFitsAfterReSerialization_IsAccepted()
    {
        // Cap applies to the STORED bytes, so pretty-printing cannot cost a user
        // their save — and the limit the client is told is the one enforced.
        _harness.Options.Limits.MaxUserSettingsBytes = 40;
        var compact = """{"version":1,"fieldList":{"g":"type"}}""";
        Assert.True(compact.Length <= 40);

        var padded = "{\n    \"version\" : 1,\n    \"fieldList\" : { \"g\" : \"type\" }\n}";
        Assert.True(padded.Length > 40);

        var result = await _service.ReplaceAsync(padded, CancellationToken.None);

        Assert.True(result.Succeeded);
        Assert.Equal(compact, Assert.Single(_harness.Db.UserSettings).SettingsJson);
    }

    // ---------------------------------------------------------- isolation ----
    // The security property of this whole store. There is no route, body field
    // or service argument that names a user: the id comes from the identity
    // seam and is the primary key, so "read someone else's settings" is not an
    // operation that exists. These pin that a shared service instance over a
    // shared DbContext still answers strictly per caller.

    [Fact]
    public async Task ASecondIdentity_CannotReadTheFirstUsersDocument()
    {
        _harness.CurrentUser.UserId = "user-1";
        await _service.ReplaceAsync("""{"version":1,"secret":"user-1 only"}""", CancellationToken.None);

        _harness.CurrentUser.UserId = "user-2";
        var asOther = await _service.GetAsync(CancellationToken.None);

        Assert.True(asOther.Succeeded);
        Assert.False(asOther.Value!.Settings.TryGetProperty("secret", out _));
        Assert.Null(asOther.Value.UpdatedAtUtc);
        Assert.Equal(1, asOther.Value.Settings.GetProperty("version").GetInt32());
    }

    [Fact]
    public async Task AdminStanding_GrantsNoAccessToAnotherUsersDocument()
    {
        // CanManageShared unlocks other people's SHARED content elsewhere in the
        // library. Personal settings are not content and are never shared, so
        // the admin flag must buy exactly nothing here.
        _harness.CurrentUser.UserId = "user-1";
        await _service.ReplaceAsync("""{"version":1,"secret":"user-1 only"}""", CancellationToken.None);

        _harness.CurrentUser.UserId = "admin";
        _harness.CurrentUser.CanManageShared = true;
        var asAdmin = await _service.GetAsync(CancellationToken.None);

        Assert.False(asAdmin.Value!.Settings.TryGetProperty("secret", out _));
    }

    [Fact]
    public async Task ASecondIdentitysWrite_CannotOverwriteTheFirstUsersRow()
    {
        _harness.CurrentUser.UserId = "user-1";
        await _service.ReplaceAsync("""{"version":1,"owner":"user-1"}""", CancellationToken.None);

        _harness.CurrentUser.UserId = "user-2";
        await _service.ReplaceAsync("""{"version":1,"owner":"user-2"}""", CancellationToken.None);

        Assert.Equal(2, _harness.Db.UserSettings.Count());

        _harness.CurrentUser.UserId = "user-1";
        var first = await _service.GetAsync(CancellationToken.None);
        Assert.Equal("user-1", first.Value!.Settings.GetProperty("owner").GetString());
    }

    // ----------------------------------------------------- anonymous callers --
    // ICurrentUserProvider.GetUserId() THROWS for an unauthenticated caller.
    // This endpoint sits in the View slot, which a host may open up, so the
    // service degrades the way MetaController does instead of turning a read
    // into a 500 — but a WRITE has no row to target and must say so.

    [Fact]
    public async Task UnauthenticatedRead_YieldsTheEmptyDocument_NotAServerError()
    {
        var anonymous = _harness.CreateUserSettingsService(new ThrowingCurrentUserProvider());

        var result = await anonymous.GetAsync(CancellationToken.None);

        Assert.True(result.Succeeded);
        Assert.Equal(1, result.Value!.Settings.GetProperty("version").GetInt32());
        Assert.Null(result.Value.UpdatedAtUtc);
    }

    [Fact]
    public async Task UnauthenticatedWrite_IsRefused_RatherThanSilentlyDiscarded()
    {
        var anonymous = _harness.CreateUserSettingsService(new ThrowingCurrentUserProvider());

        var result = await anonymous.ReplaceAsync("""{"version":1}""", CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal(ServiceErrorKind.Forbidden, result.Error!.Kind);
        Assert.Equal("rcd.user_settings.unidentified", result.Error.Code);
        Assert.Empty(_harness.Db.UserSettings);
    }

    [Fact]
    public async Task ABlankIdentity_IsTreatedAsNoIdentity_NeverAsASharedRow()
    {
        var blank = _harness.CreateUserSettingsService(new FakeCurrentUserProvider { UserId = "  " });

        var write = await blank.ReplaceAsync("""{"version":1,"leak":true}""", CancellationToken.None);

        Assert.False(write.Succeeded);
        Assert.Equal("rcd.user_settings.unidentified", write.Error!.Code);
        Assert.Empty(_harness.Db.UserSettings);
    }

    /// <summary>The documented contract of the identity seam for an anonymous caller.</summary>
    private sealed class ThrowingCurrentUserProvider : ICurrentUserProvider
    {
        public bool CanManageShared => false;

        public string GetUserId() => throw new InvalidOperationException("No authenticated user.");
    }
}
