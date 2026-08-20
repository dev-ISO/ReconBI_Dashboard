using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Persistence;
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

    // ---------- duplicate ----------

    /// <summary>Creates a shared model owned by someone else and returns its id.</summary>
    private async Task<int> CreateSharedModelOwnedByOtherAsync(string name, string ownerUserId = "owner-user")
    {
        var callerUserId = _harness.CurrentUser.UserId;
        var callerCanManageShared = _harness.CurrentUser.CanManageShared;

        _harness.CurrentUser.UserId = ownerUserId;
        _harness.CurrentUser.CanManageShared = true;
        var created = await _service.CreateAsync(ValidRequest(name, isShared: true), CancellationToken.None);
        Assert.True(created.Succeeded);

        _harness.CurrentUser.UserId = callerUserId;
        _harness.CurrentUser.CanManageShared = callerCanManageShared;
        return created.Value!.Id;
    }

    [Fact]
    public async Task DuplicateOfSharedModelGivesCallerAnUnsharedOwnedCopy()
    {
        var sourceId = await CreateSharedModelOwnedByOtherAsync("Company Default");

        var copy = await _service.DuplicateAsync(sourceId, CancellationToken.None);

        Assert.True(copy.Succeeded);
        var model = copy.Value!;
        Assert.Equal("Company Default (copy)", model.Name);
        Assert.Equal("user-1", model.OwnerUserId);
        Assert.False(model.IsShared);
        Assert.NotEqual(sourceId, model.Id);

        // The definition came across intact.
        var source = await _service.GetAsync(sourceId, CancellationToken.None);
        Assert.Equal(
            ModelJson.Serialize(source.Value!.Definition),
            ModelJson.Serialize(model.Definition));
        Assert.Equal(source.Value.Description, model.Description);
        Assert.Equal(source.Value.DataSourceName, model.DataSourceName);

        // The source is untouched and still shared.
        Assert.True((await _service.GetAsync(sourceId, CancellationToken.None)).Value!.IsShared);
    }

    [Fact]
    public async Task RepeatedDuplicatesWalkTheCopyNumberSequence()
    {
        var sourceId = await CreateSharedModelOwnedByOtherAsync("Company Default");

        var first = await _service.DuplicateAsync(sourceId, CancellationToken.None);
        var second = await _service.DuplicateAsync(sourceId, CancellationToken.None);
        var third = await _service.DuplicateAsync(sourceId, CancellationToken.None);

        Assert.Equal("Company Default (copy)", first.Value!.Name);
        Assert.Equal("Company Default (copy 2)", second.Value!.Name);
        Assert.Equal("Company Default (copy 3)", third.Value!.Name);

        // Freeing a slot in the middle lets the next duplicate reclaim it.
        Assert.True((await _service.DeleteAsync(second.Value.Id, CancellationToken.None)).Succeeded);
        var fourth = await _service.DuplicateAsync(sourceId, CancellationToken.None);
        Assert.Equal("Company Default (copy 2)", fourth.Value!.Name);
    }

    [Fact]
    public async Task CopyNumberSequenceIsPerUserNotGlobal()
    {
        var sourceId = await CreateSharedModelOwnedByOtherAsync("Company Default");

        var mine = await _service.DuplicateAsync(sourceId, CancellationToken.None);
        Assert.Equal("Company Default (copy)", mine.Value!.Name);

        // Another author's first copy is unaffected by mine.
        _harness.CurrentUser.UserId = "user-2";
        var theirs = await _service.DuplicateAsync(sourceId, CancellationToken.None);
        Assert.Equal("Company Default (copy)", theirs.Value!.Name);
        Assert.Equal("user-2", theirs.Value.OwnerUserId);
    }

    [Fact]
    public async Task DuplicateOfAnotherUsersPrivateModelIsNotFound()
    {
        _harness.CurrentUser.UserId = "owner-user";
        var created = await _service.CreateAsync(ValidRequest("Their Private Model"), CancellationToken.None);
        Assert.True(created.Succeeded);

        _harness.CurrentUser.UserId = "user-1";
        var copy = await _service.DuplicateAsync(created.Value!.Id, CancellationToken.None);

        Assert.False(copy.Succeeded);
        Assert.Equal(ServiceErrorKind.NotFound, copy.Error!.Kind);
        Assert.Equal("rcd.model.not_found", copy.Error.Code);
    }

    [Fact]
    public async Task DuplicateRespectsMaxModelsPerUser()
    {
        var sourceId = await CreateSharedModelOwnedByOtherAsync("Company Default");
        _harness.Options.Limits.MaxModelsPerUser = 1;

        var first = await _service.DuplicateAsync(sourceId, CancellationToken.None);
        Assert.True(first.Succeeded);

        var second = await _service.DuplicateAsync(sourceId, CancellationToken.None);

        Assert.False(second.Succeeded);
        Assert.Equal(ServiceErrorKind.LimitExceeded, second.Error!.Kind);
        Assert.Equal("rcd.limit.models", second.Error.Code);
    }

    [Fact]
    public async Task DuplicateOfALongNameStaysWithinTheNameColumn()
    {
        var longName = new string('x', 128);
        var sourceId = await CreateSharedModelOwnedByOtherAsync(longName);

        var copy = await _service.DuplicateAsync(sourceId, CancellationToken.None);

        Assert.True(copy.Succeeded);
        Assert.EndsWith(" (copy)", copy.Value!.Name);
        Assert.True(copy.Value.Name.Length <= 128, $"Name was {copy.Value.Name.Length} chars.");
    }

    // ---------- export / import ----------

    [Fact]
    public async Task ExportReturnsThePortableDocumentForAVisibleModel()
    {
        var sourceId = await CreateSharedModelOwnedByOtherAsync("Company Default");

        var exported = await _service.ExportAsync(sourceId, CancellationToken.None);

        Assert.True(exported.Succeeded);
        var document = exported.Value!;
        Assert.Equal("Company Default", document.Name);
        Assert.Equal("A demo model", document.Description);
        Assert.Equal(TestFixtures.DemoConnectionName, document.DataSourceName);
        Assert.Equal(2, document.Definition.Tables.Count);
        Assert.Single(document.Definition.Measures);
    }

    [Fact]
    public async Task ExportOfAnotherUsersPrivateModelIsNotFound()
    {
        _harness.CurrentUser.UserId = "owner-user";
        var created = await _service.CreateAsync(ValidRequest("Their Private Model"), CancellationToken.None);
        Assert.True(created.Succeeded);

        _harness.CurrentUser.UserId = "user-1";
        var exported = await _service.ExportAsync(created.Value!.Id, CancellationToken.None);

        Assert.False(exported.Succeeded);
        Assert.Equal(ServiceErrorKind.NotFound, exported.Error!.Kind);
        Assert.Equal("rcd.model.not_found", exported.Error.Code);
    }

    [Fact]
    public async Task ExportRoundTripsThroughImportIdentically()
    {
        var created = await _service.CreateAsync(ValidRequest("Round Trip"), CancellationToken.None);
        Assert.True(created.Succeeded);

        var exported = await _service.ExportAsync(created.Value!.Id, CancellationToken.None);
        Assert.True(exported.Succeeded);
        var document = exported.Value!;

        // Same document, new name (the original still occupies the old one).
        var imported = await _service.ImportAsync(
            new ModelSaveRequest(
                "Round Trip Imported", document.Description, document.DataSourceName,
                ModelJson.Serialize(document.Definition)),
            CancellationToken.None);

        Assert.True(imported.Succeeded);
        Assert.Equal("Round Trip Imported", imported.Value!.Name);
        Assert.Equal("user-1", imported.Value.OwnerUserId);
        Assert.False(imported.Value.IsShared);

        // Re-exporting the import yields a byte-identical definition.
        var reExported = await _service.ExportAsync(imported.Value.Id, CancellationToken.None);
        Assert.True(reExported.Succeeded);
        Assert.Equal(
            ModelJson.Serialize(document.Definition),
            ModelJson.Serialize(reExported.Value!.Definition));
        Assert.Equal(document.Description, reExported.Value.Description);
        Assert.Equal(document.DataSourceName, reExported.Value.DataSourceName);
    }

    [Fact]
    public async Task ImportNeverCreatesASharedModelEvenWhenAsked()
    {
        _harness.CurrentUser.CanManageShared = true;

        var imported = await _service.ImportAsync(
            ValidRequest("Imported Model", isShared: true), CancellationToken.None);

        Assert.True(imported.Succeeded);
        Assert.False(imported.Value!.IsShared);
    }

    [Fact]
    public async Task ImportOfADuplicateNameReturnsTheStandardNameConflict()
    {
        Assert.True((await _service.CreateAsync(ValidRequest("Taken Name"), CancellationToken.None)).Succeeded);

        var imported = await _service.ImportAsync(ValidRequest("Taken Name"), CancellationToken.None);

        Assert.False(imported.Succeeded);
        Assert.Equal(ServiceErrorKind.Conflict, imported.Error!.Kind);
        Assert.Equal("rcd.model.name_conflict", imported.Error.Code);
    }

    [Fact]
    public async Task ImportRunsTheSameCatalogValidationAsCreate()
    {
        var brokenDefinition = TestFixtures.BuildValidDemoModel() with
        {
            Measures =
            [
                TestFixtures.BuildMeasure("Broken", "public.orders", Aggregation.Sum, "no_such_column"),
            ],
        };
        var request = ValidRequest("Imported Broken Model") with
        {
            DefinitionJson = ModelJson.Serialize(brokenDefinition),
        };

        var imported = await _service.ImportAsync(request, CancellationToken.None);

        Assert.False(imported.Succeeded);
        Assert.Equal(ServiceErrorKind.Validation, imported.Error!.Kind);
        Assert.Equal("rcd.model.invalid", imported.Error.Code);
        Assert.NotNull(imported.Error.Validation);
        Assert.Contains(imported.Error.Validation.Errors, e => e.Code.StartsWith("MDL"));
    }

    [Fact]
    public async Task ImportRespectsMaxModelsPerUser()
    {
        _harness.Options.Limits.MaxModelsPerUser = 1;
        Assert.True((await _service.ImportAsync(ValidRequest("First Import"), CancellationToken.None)).Succeeded);

        var second = await _service.ImportAsync(ValidRequest("Second Import"), CancellationToken.None);

        Assert.False(second.Succeeded);
        Assert.Equal(ServiceErrorKind.LimitExceeded, second.Error!.Kind);
        Assert.Equal("rcd.limit.models", second.Error.Code);
    }

    [Fact]
    public async Task ImportOfAnUnknownDataSourceIsRejected()
    {
        var imported = await _service.ImportAsync(
            ValidRequest("Foreign Import", dataSourceName: "no-such-source"), CancellationToken.None);

        Assert.False(imported.Succeeded);
        Assert.Equal(ServiceErrorKind.BadRequest, imported.Error!.Kind);
        Assert.Equal("rcd.source.unknown", imported.Error.Code);
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

    // ------------------------------------------ the System-scope measure carve-out

    /// <summary>
    /// The problem this exists to solve: a seeded model refuses every write, so
    /// a System-scope measure could ONLY be created by hand-editing the seed
    /// JSON and re-seeding. One door is now open — measures, for a caller who
    /// may manage shared content — and the rest of the model is exactly as
    /// immutable as it was.
    /// </summary>
    private const string SystemModelName = "Built-in Model";

    /// <summary>
    /// The seeded definition every carve-out test edits. It must be the SAME
    /// object the row holds — TestFixtures.BuildValidDemoModel() mints a fresh
    /// relationship GUID on each call, and a differing relationship id is a
    /// non-measure change, exactly as the carve-out says.
    /// </summary>
    private ModelDefinition _systemDefinition = TestFixtures.BuildValidDemoModel();

    private async Task<int> SeedSystemModelAsync()
    {
        _systemDefinition = TestFixtures.BuildValidDemoModel();
        var record = new DataModelRecord
        {
            Name = SystemModelName,
            Description = "Seeded",
            DataSourceName = TestFixtures.DemoConnectionName,
            DefinitionJson = ModelJson.Serialize(_systemDefinition),
            OwnerUserId = _harness.Options.SystemOwnerUserId!,
            IsShared = true,
            CreatedAtUtc = DateTime.UtcNow,
            UpdatedAtUtc = DateTime.UtcNow,
        };
        _harness.Db.DataModels.Add(record);
        await _harness.Db.SaveChangesAsync();
        return record.Id;
    }

    private static ModelSaveRequest SystemSaveRequest(
        ModelDefinition definition,
        string name = SystemModelName,
        string? description = "Seeded",
        bool isShared = true) =>
        new(name, description, TestFixtures.DemoConnectionName, ModelJson.Serialize(definition), isShared);

    [Fact]
    public async Task SystemModel_AnAdminMayAddAMeasure()
    {
        var id = await SeedSystemModelAsync();
        _harness.CurrentUser.CanManageShared = true;

        var withMeasure = _systemDefinition with
        {
            Measures =
            [
                .. _systemDefinition.Measures,
                TestFixtures.BuildMeasure("Order Count", "public.orders", Aggregation.Count),
            ],
        };

        var saved = await _service.UpdateAsync(id, SystemSaveRequest(withMeasure), CancellationToken.None);

        Assert.True(saved.Succeeded, saved.Error?.Message);
        Assert.Equal(2, saved.Value!.Definition.Measures.Count);
        Assert.Contains(saved.Value.Definition.Measures, m => m.Name == "Order Count");
    }

    [Fact]
    public async Task SystemModel_AnAdminMayEditAndRemoveMeasuresToo()
    {
        var id = await SeedSystemModelAsync();
        _harness.CurrentUser.CanManageShared = true;

        var emptied = _systemDefinition with { Measures = [] };

        var saved = await _service.UpdateAsync(id, SystemSaveRequest(emptied), CancellationToken.None);

        Assert.True(saved.Succeeded, saved.Error?.Message);
        Assert.Empty(saved.Value!.Definition.Measures);
    }

    [Fact]
    public async Task SystemModel_ATableEditIsRefusedWithItsOwnCode()
    {
        var id = await SeedSystemModelAsync();
        _harness.CurrentUser.CanManageShared = true;

        var renamedTable = _systemDefinition with
        {
            Tables = [_systemDefinition.Tables[0] with { FriendlyName = "Clients" }, _systemDefinition.Tables[1]],
        };

        var saved = await _service.UpdateAsync(id, SystemSaveRequest(renamedTable), CancellationToken.None);

        Assert.False(saved.Succeeded);
        Assert.Equal(ServiceErrorKind.Forbidden, saved.Error!.Kind);
        Assert.Equal("rcd.model.system_measures_only", saved.Error.Code);
    }

    [Fact]
    public async Task SystemModel_ATableEditSmuggledInAlongsideAMeasureEditIsStillRefused()
    {
        // The carve-out is "measures ONLY", not "measures too".
        var id = await SeedSystemModelAsync();
        _harness.CurrentUser.CanManageShared = true;

        var both = _systemDefinition with
        {
            Tables = [_systemDefinition.Tables[0] with { FriendlyName = "Clients" }, _systemDefinition.Tables[1]],
            Measures = [.. _systemDefinition.Measures, TestFixtures.BuildMeasure("Order Count", "public.orders", Aggregation.Count)],
        };

        var saved = await _service.UpdateAsync(id, SystemSaveRequest(both), CancellationToken.None);

        Assert.False(saved.Succeeded);
        Assert.Equal("rcd.model.system_measures_only", saved.Error!.Code);

        // And nothing was written: the measure did not sneak through either.
        var reloaded = await _service.GetAsync(id, CancellationToken.None);
        Assert.Single(reloaded.Value!.Definition.Measures);
    }

    [Fact]
    public async Task SystemModel_ARelationshipEditIsRefused()
    {
        var id = await SeedSystemModelAsync();
        _harness.CurrentUser.CanManageShared = true;

        var deactivated = _systemDefinition with
        {
            Relationships = [_systemDefinition.Relationships[0] with { IsActive = false }],
        };

        var saved = await _service.UpdateAsync(id, SystemSaveRequest(deactivated), CancellationToken.None);

        Assert.False(saved.Succeeded);
        Assert.Equal("rcd.model.system_measures_only", saved.Error!.Code);
    }

    [Theory]
    [InlineData("Renamed Model", "Seeded", true)]
    [InlineData(SystemModelName, "Different description", true)]
    [InlineData(SystemModelName, "Seeded", false)]
    public async Task SystemModel_RenameDescriptionAndSharingChangesAreAllRefused(
        string name, string? description, bool isShared)
    {
        var id = await SeedSystemModelAsync();
        _harness.CurrentUser.CanManageShared = true;

        var withMeasure = _systemDefinition with
        {
            Measures = [.. _systemDefinition.Measures, TestFixtures.BuildMeasure("Order Count", "public.orders", Aggregation.Count)],
        };

        var saved = await _service.UpdateAsync(
            id, SystemSaveRequest(withMeasure, name, description, isShared), CancellationToken.None);

        Assert.False(saved.Succeeded);
        Assert.Equal("rcd.model.system_measures_only", saved.Error!.Code);
    }

    [Fact]
    public async Task SystemModel_ASaveThatChangesNothingIsStillTheOldFlatRefusal()
    {
        // The pinned behaviour (DashboardSharingTests.SystemModel_UpdateAndDelete
        // ReadOnly_ButDuplicateAllowed re-saves a system model unchanged): the
        // carve-out is for MEASURE EDITS, and a no-op is not one.
        var id = await SeedSystemModelAsync();
        _harness.CurrentUser.CanManageShared = true;

        var saved = await _service.UpdateAsync(
            id, SystemSaveRequest(_systemDefinition), CancellationToken.None);

        Assert.False(saved.Succeeded);
        Assert.Equal("rcd.model.system_readonly", saved.Error!.Code);
    }

    [Fact]
    public async Task SystemModel_ANonAdminIsStillRefusedOutright()
    {
        var id = await SeedSystemModelAsync();
        _harness.CurrentUser.CanManageShared = false;

        var withMeasure = _systemDefinition with
        {
            Measures = [.. _systemDefinition.Measures, TestFixtures.BuildMeasure("Order Count", "public.orders", Aggregation.Count)],
        };

        var saved = await _service.UpdateAsync(id, SystemSaveRequest(withMeasure), CancellationToken.None);

        Assert.False(saved.Succeeded);
        Assert.Equal(ServiceErrorKind.Forbidden, saved.Error!.Kind);
        Assert.Equal("rcd.model.system_readonly", saved.Error.Code);
    }

    [Fact]
    public async Task SystemModel_DeleteStaysRefusedEvenForAnAdmin()
    {
        var id = await SeedSystemModelAsync();
        _harness.CurrentUser.CanManageShared = true;

        var deleted = await _service.DeleteAsync(id, CancellationToken.None);

        Assert.False(deleted.Succeeded);
        Assert.Equal("rcd.model.system_readonly", deleted.Error!.Code);
    }

    [Fact]
    public async Task SystemModel_AMeasureEditStillFacesTheNormalCatalogValidation()
    {
        var id = await SeedSystemModelAsync();
        _harness.CurrentUser.CanManageShared = true;

        var broken = _systemDefinition with
        {
            Measures = [TestFixtures.BuildMeasure("Broken", "public.orders", Aggregation.Sum, "no_such_column")],
        };

        var saved = await _service.UpdateAsync(id, SystemSaveRequest(broken), CancellationToken.None);

        Assert.False(saved.Succeeded);
        Assert.Equal("rcd.model.invalid", saved.Error!.Code);
    }

    [Fact]
    public async Task SystemModel_WithNoSystemOwnerConfiguredNothingChanges()
    {
        // The rule is opt-in via SystemOwnerUserId; with it unset a model owned
        // by "system" is an ordinary model and the carve-out never engages.
        var id = await SeedSystemModelAsync();
        _harness.Options.SystemOwnerUserId = null;
        _harness.CurrentUser.CanManageShared = true;

        var renamed = await _service.UpdateAsync(
            id,
            SystemSaveRequest(_systemDefinition, name: "Renamed Model"),
            CancellationToken.None);

        Assert.True(renamed.Succeeded, renamed.Error?.Message);
        Assert.Equal("Renamed Model", renamed.Value!.Name);
    }
}
