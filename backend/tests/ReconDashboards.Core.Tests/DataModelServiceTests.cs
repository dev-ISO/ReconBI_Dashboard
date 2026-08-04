using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Services;

namespace ReconDashboards.Core.Tests;

public class DataModelServiceTests : IDisposable
{
    private readonly ServiceTestHarness _harness = new();
    private readonly DataModelService _service;

    public DataModelServiceTests()
    {
        _service = _harness.CreateDataModelService();
    }

    public void Dispose() => _harness.Dispose();

    private static ModelSaveRequest ValidRequest(
        string name,
        bool isShared = false,
        DateTime? expectedUpdatedAtUtc = null,
        string dataSourceName = TestFixtures.DemoConnectionName) =>
        new(name, "A demo model", dataSourceName,
            ModelJson.Serialize(TestFixtures.BuildValidDemoModel()), isShared, expectedUpdatedAtUtc);

    [Fact]
    public async Task CreateThenGetRoundTripsTheModel()
    {
        var created = await _service.CreateAsync(ValidRequest("Sales Model"), CancellationToken.None);

        Assert.True(created.Succeeded);
        Assert.NotNull(created.Value);

        var fetched = await _service.GetAsync(created.Value.Id, CancellationToken.None);

        Assert.True(fetched.Succeeded);
        var model = fetched.Value!;
        Assert.Equal("Sales Model", model.Name);
        Assert.Equal(TestFixtures.DemoConnectionName, model.DataSourceName);
        Assert.Equal("user-1", model.OwnerUserId);
        Assert.Equal(2, model.Definition.Tables.Count);
        Assert.Single(model.Definition.Relationships);
        Assert.Single(model.Definition.Measures);
        Assert.Equal("Total Order Value", model.Definition.Measures[0].Name);
    }

    [Fact]
    public async Task ListShowsOwnAndOthersSharedModelsButHidesOthersPrivateModels()
    {
        await _service.CreateAsync(ValidRequest("My Own Model"), CancellationToken.None);

        _harness.CurrentUser.UserId = "user-2";
        _harness.CurrentUser.CanManageShared = true;
        await _service.CreateAsync(ValidRequest("Their Shared Model", isShared: true), CancellationToken.None);
        await _service.CreateAsync(ValidRequest("Their Private Model"), CancellationToken.None);

        _harness.CurrentUser.UserId = "user-1";
        _harness.CurrentUser.CanManageShared = false;
        var visible = await _service.ListVisibleAsync(CancellationToken.None);

        Assert.Equal(2, visible.Count);
        var own = Assert.Single(visible, m => m.Name == "My Own Model");
        Assert.True(own.OwnerIsMe);
        var shared = Assert.Single(visible, m => m.Name == "Their Shared Model");
        Assert.False(shared.OwnerIsMe);
        Assert.DoesNotContain(visible, m => m.Name == "Their Private Model");
    }

    [Fact]
    public async Task CreateWithInvalidDefinitionReturnsValidationErrorCarryingModelCodes()
    {
        var brokenDefinition = TestFixtures.BuildValidDemoModel() with
        {
            Measures =
            [
                TestFixtures.BuildMeasure("Broken", "public.orders", Aggregation.Sum, "no_such_column"),
            ],
        };
        var request = ValidRequest("Broken Model") with { DefinitionJson = ModelJson.Serialize(brokenDefinition) };

        var result = await _service.CreateAsync(request, CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal(ServiceErrorKind.Validation, result.Error!.Kind);
        Assert.Equal("rcd.model.invalid", result.Error.Code);
        Assert.NotNull(result.Error.Validation);
        Assert.Contains(result.Error.Validation.Errors, e => e.Code.StartsWith("MDL"));
    }

    [Fact]
    public async Task CreateWithUnknownDataSourceReturnsUnknownSourceError()
    {
        var result = await _service.CreateAsync(
            ValidRequest("Orphan Model", dataSourceName: "no-such-source"), CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal(ServiceErrorKind.BadRequest, result.Error!.Kind);
        Assert.Equal("rcd.source.unknown", result.Error.Code);
    }

    [Fact]
    public async Task DuplicateNameIsRejectedButAllowedAgainAfterSoftDelete()
    {
        var first = await _service.CreateAsync(ValidRequest("Reused Name"), CancellationToken.None);
        Assert.True(first.Succeeded);

        var duplicate = await _service.CreateAsync(ValidRequest("Reused Name"), CancellationToken.None);

        Assert.False(duplicate.Succeeded);
        Assert.Equal(ServiceErrorKind.Conflict, duplicate.Error!.Kind);
        Assert.Equal("rcd.model.name_conflict", duplicate.Error.Code);

        var deleted = await _service.DeleteAsync(first.Value!.Id, CancellationToken.None);
        Assert.True(deleted.Succeeded);

        var recreated = await _service.CreateAsync(ValidRequest("Reused Name"), CancellationToken.None);
        Assert.True(recreated.Succeeded);
    }

    [Fact]
    public async Task UpdateOfSharedModelByNonOwnerRequiresManageSharedPermission()
    {
        _harness.CurrentUser.UserId = "owner-user";
        _harness.CurrentUser.CanManageShared = true;
        var created = await _service.CreateAsync(ValidRequest("Shared Model", isShared: true), CancellationToken.None);
        Assert.True(created.Succeeded);

        _harness.CurrentUser.UserId = "other-user";
        _harness.CurrentUser.CanManageShared = false;
        var forbidden = await _service.UpdateAsync(
            created.Value!.Id, ValidRequest("Shared Model Edited", isShared: true), CancellationToken.None);

        Assert.False(forbidden.Succeeded);
        Assert.Equal(ServiceErrorKind.Forbidden, forbidden.Error!.Kind);
        Assert.Equal("rcd.model.forbidden", forbidden.Error.Code);

        _harness.CurrentUser.CanManageShared = true;
        var allowed = await _service.UpdateAsync(
            created.Value.Id, ValidRequest("Shared Model Edited", isShared: true), CancellationToken.None);

        Assert.True(allowed.Succeeded);
        Assert.Equal("Shared Model Edited", allowed.Value!.Name);
        Assert.Equal("owner-user", allowed.Value.OwnerUserId);
    }

    [Fact]
    public async Task SettingIsSharedRequiresManageSharedPermission()
    {
        var createShared = await _service.CreateAsync(ValidRequest("Wannabe Shared", isShared: true), CancellationToken.None);
        Assert.False(createShared.Succeeded);
        Assert.Equal("rcd.model.share_forbidden", createShared.Error!.Code);

        var created = await _service.CreateAsync(ValidRequest("Private Model"), CancellationToken.None);
        Assert.True(created.Succeeded);

        var shareWithoutPermission = await _service.UpdateAsync(
            created.Value!.Id, ValidRequest("Private Model", isShared: true), CancellationToken.None);

        Assert.False(shareWithoutPermission.Succeeded);
        Assert.Equal(ServiceErrorKind.Forbidden, shareWithoutPermission.Error!.Kind);
        Assert.Equal("rcd.model.share_forbidden", shareWithoutPermission.Error.Code);

        _harness.CurrentUser.CanManageShared = true;
        var shareWithPermission = await _service.UpdateAsync(
            created.Value.Id, ValidRequest("Private Model", isShared: true), CancellationToken.None);

        Assert.True(shareWithPermission.Succeeded);
        Assert.True(shareWithPermission.Value!.IsShared);
    }

    [Fact]
    public async Task StaleExpectedUpdatedAtProducesConflict()
    {
        var created = await _service.CreateAsync(ValidRequest("Concurrent Model"), CancellationToken.None);
        Assert.True(created.Succeeded);

        var stale = await _service.UpdateAsync(
            created.Value!.Id,
            ValidRequest("Concurrent Model", expectedUpdatedAtUtc: created.Value.UpdatedAtUtc.AddMinutes(-5)),
            CancellationToken.None);

        Assert.False(stale.Succeeded);
        Assert.Equal(ServiceErrorKind.Conflict, stale.Error!.Kind);
        Assert.Equal("rcd.model.stale", stale.Error.Code);

        var current = await _service.UpdateAsync(
            created.Value.Id,
            ValidRequest("Concurrent Model", expectedUpdatedAtUtc: created.Value.UpdatedAtUtc),
            CancellationToken.None);

        Assert.True(current.Succeeded);
    }

    [Fact]
    public async Task DeleteSoftDeletesAndHidesFromListAndGet()
    {
        var created = await _service.CreateAsync(ValidRequest("Disposable Model"), CancellationToken.None);
        Assert.True(created.Succeeded);

        var deleted = await _service.DeleteAsync(created.Value!.Id, CancellationToken.None);
        Assert.True(deleted.Succeeded);

        var visible = await _service.ListVisibleAsync(CancellationToken.None);
        Assert.DoesNotContain(visible, m => m.Id == created.Value.Id);

        var fetched = await _service.GetAsync(created.Value.Id, CancellationToken.None);
        Assert.False(fetched.Succeeded);
        Assert.Equal(ServiceErrorKind.NotFound, fetched.Error!.Kind);
        Assert.Equal("rcd.model.not_found", fetched.Error.Code);

        var record = _harness.Db.DataModels.Single(m => m.Id == created.Value.Id);
        Assert.True(record.IsDeleted);
    }

    [Fact]
    public async Task DefinitionLargerThanConfiguredLimitReturnsModelSizeError()
    {
        _harness.Options.Limits.MaxModelDefinitionBytes = 16;

        var result = await _service.CreateAsync(ValidRequest("Oversized Model"), CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal(ServiceErrorKind.LimitExceeded, result.Error!.Kind);
        Assert.Equal("rcd.limit.model_size", result.Error.Code);
    }
}
