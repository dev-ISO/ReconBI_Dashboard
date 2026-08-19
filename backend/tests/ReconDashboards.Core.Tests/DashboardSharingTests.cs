using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Modeling;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Services;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// Wave 19 rules: named-user shares, differ-gated grantee saves, contextual
/// delete, system read-only rows, and the per-dashboard activity log.
/// </summary>
public class DashboardSharingTests : IDisposable
{
    private const string Owner = "owner-user";
    private const string Grantee = "grantee-user";
    private const string Bystander = "bystander-user";

    private const string TwoTileLayout = """
        {"pages":[{"id":"p1","name":"Main","tiles":[
          {"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},"chart":{"title":"Orders","type":"column"}},
          {"id":"t2","kind":"text","layout":{"x":4,"y":0,"w":2,"h":1},"text":{"content":"hello"}}]}]}
        """;

    private readonly ServiceTestHarness _harness = new();
    private readonly DashboardService _service;

    public DashboardSharingTests()
    {
        _service = _harness.CreateDashboardService();
        _harness.CurrentUser.UserId = Owner;
    }

    public void Dispose() => _harness.Dispose();

    private void ActAs(string userId, bool admin = false)
    {
        _harness.CurrentUser.UserId = userId;
        _harness.CurrentUser.CanManageShared = admin;
    }

    private async Task<int> CreateOwnedDashboardAsync(string name = "Board", string? layout = null)
    {
        var created = await _service.CreateAsync(
            new DashboardSaveRequest(name, "desc", ModelId: null, layout ?? TwoTileLayout),
            CancellationToken.None);
        Assert.True(created.Succeeded, created.Error?.Message);
        return created.Value!.Id;
    }

    private async Task<int> CreatePublishedDashboardAsync(string name = "Board")
    {
        ActAs(Owner, admin: true);
        var created = await _service.CreateAsync(
            new DashboardSaveRequest(name, "desc", ModelId: null, TwoTileLayout, IsShared: true),
            CancellationToken.None);
        Assert.True(created.Succeeded, created.Error?.Message);
        ActAs(Owner);
        return created.Value!.Id;
    }

    private async Task ShareWithAsync(
        int id, string userId,
        bool layout = false, bool pages = false, bool charts = false,
        bool move = false, bool delete = false)
    {
        var result = await _service.ReplaceSharesAsync(
            id, [new DashboardShareGrant(userId, layout, pages, charts, move, delete)], CancellationToken.None);
        Assert.True(result.Succeeded, result.Error?.Message);
    }

    private DashboardSaveRequest SaveRequest(
        string name = "Board", string? description = "desc", int? modelId = null,
        string? layout = null, bool isShared = false) =>
        new(name, description, modelId, layout ?? TwoTileLayout, isShared);

    private static string MoveTile(string layout) => layout.Replace("\"x\":0", "\"x\":6");

    private static string EditChart(string layout) => layout.Replace("\"type\":\"column\"", "\"type\":\"line\"");

    private static string RenamePage(string layout) => layout.Replace("\"name\":\"Main\"", "\"name\":\"Renamed\"");

    private static string EditText(string layout) => layout.Replace("\"content\":\"hello\"", "\"content\":\"edited\"");

    private static string RenameChart(string layout) => layout.Replace("\"title\":\"Orders\"", "\"title\":\"Sales\"");

    /// <summary>TwoTileLayout minus the text tile t2 (a layout-class removal → also the delete gate).</summary>
    private const string ChartTileOnlyLayout = """
        {"pages":[{"id":"p1","name":"Main","tiles":[
          {"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},"chart":{"title":"Orders","type":"column"}}]}]}
        """;

    /// <summary>TwoTileLayout minus the chart tile t1 (a charts-class removal → also the delete gate).</summary>
    private const string TextTileOnlyLayout = """
        {"pages":[{"id":"p1","name":"Main","tiles":[
          {"id":"t2","kind":"text","layout":{"x":4,"y":0,"w":2,"h":1},"text":{"content":"hello"}}]}]}
        """;

    /// <summary>TwoTileLayout plus a second, empty page (page-removal tests).</summary>
    private const string TwoPageLayout = """
        {"pages":[{"id":"p1","name":"Main","tiles":[
          {"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},"chart":{"title":"Orders","type":"column"}},
          {"id":"t2","kind":"text","layout":{"x":4,"y":0,"w":2,"h":1},"text":{"content":"hello"}}]},
          {"id":"p2","name":"Extra","tiles":[]}]}
        """;

    // ------------------------------ visibility ------------------------------

    [Fact]
    public async Task ShareRowMakesPrivateDashboardVisible_ToGranteeOnly()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee);

        ActAs(Grantee);
        var listed = Assert.Single(await _service.ListVisibleAsync(CancellationToken.None));
        Assert.Equal(id, listed.Id);
        Assert.True(listed.MyAccess.ViaShare);
        Assert.False(listed.MyAccess.CanEdit);
        Assert.True((await _service.GetAsync(id, CancellationToken.None)).Succeeded);

        ActAs(Bystander);
        Assert.Empty(await _service.ListVisibleAsync(CancellationToken.None));
        var fetched = await _service.GetAsync(id, CancellationToken.None);
        Assert.Equal("rcd.dashboard.not_found", fetched.Error!.Code);
    }

    [Fact]
    public async Task AccessFlags_OwnerAdminGranteePublish()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true);
        ActAs(Owner, admin: true);
        var shared = await _service.UpdateAsync(id, SaveRequest(isShared: true), CancellationToken.None);
        Assert.True(shared.Succeeded);

        ActAs(Owner);
        var owner = (await _service.GetAsync(id, CancellationToken.None)).Value!.MyAccess;
        Assert.True(owner is { IsOwner: true, CanEdit: true, CanEditLayout: true, CanManagePages: true, CanEditCharts: true, ViaShare: false, ViaPublish: false });

        ActAs(Bystander, admin: true);
        var admin = (await _service.GetAsync(id, CancellationToken.None)).Value!.MyAccess;
        Assert.True(admin is { IsOwner: false, CanEdit: true, CanEditLayout: true, CanManagePages: true, CanEditCharts: true, ViaPublish: true });

        ActAs(Grantee);
        var grantee = (await _service.GetAsync(id, CancellationToken.None)).Value!.MyAccess;
        Assert.True(grantee is { IsOwner: false, CanEdit: true, CanEditLayout: true, CanManagePages: false, CanEditCharts: false, ViaShare: true, ViaPublish: false });

        ActAs(Bystander);
        var viewer = (await _service.GetAsync(id, CancellationToken.None)).Value!.MyAccess;
        Assert.True(viewer is { IsOwner: false, CanEdit: false, ViaShare: false, ViaPublish: true });
    }

    [Fact]
    public async Task ShareCountVisibleToOwnerAndAdmin_NotToOthers()
    {
        var id = await CreatePublishedDashboardAsync();
        await ShareWithAsync(id, Grantee);

        Assert.Equal(1, (await _service.GetAsync(id, CancellationToken.None)).Value!.ShareCount);

        ActAs(Grantee);
        Assert.Equal(0, (await _service.GetAsync(id, CancellationToken.None)).Value!.ShareCount);

        ActAs(Bystander, admin: true);
        Assert.Equal(1, (await _service.GetAsync(id, CancellationToken.None)).Value!.ShareCount);
    }

    // ---------------------------- grantee saves ----------------------------

    [Theory]
    [InlineData(true, false, false, false)]
    [InlineData(false, true, false, false)]
    [InlineData(false, false, true, false)]
    [InlineData(false, false, false, true)]
    public async Task GranteeSave_EachFlagCoversExactlyItsClass(bool layout, bool pages, bool charts, bool move)
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout, pages, charts, move);
        ActAs(Grantee);

        // 0.11.1: pure move/resize rides CanMoveTiles, NOT CanEditLayout.
        var moveResult = await _service.UpdateAsync(id, SaveRequest(layout: MoveTile(TwoTileLayout)), CancellationToken.None);
        Assert.Equal(move, moveResult.Succeeded);

        var textResult = await _service.UpdateAsync(id, SaveRequest(layout: EditText(TwoTileLayout)), CancellationToken.None);
        Assert.Equal(layout, textResult.Succeeded);

        var pageResult = await _service.UpdateAsync(id, SaveRequest(layout: RenamePage(TwoTileLayout)), CancellationToken.None);
        Assert.Equal(pages, pageResult.Succeeded);

        var chartResult = await _service.UpdateAsync(id, SaveRequest(layout: EditChart(TwoTileLayout)), CancellationToken.None);
        Assert.Equal(charts, chartResult.Succeeded);

        var denied = new[] { moveResult, textResult, pageResult, chartResult }.First(r => !r.Succeeded);
        Assert.Equal("rcd.dashboard.permission_denied", denied.Error!.Code);
    }

    // ------------------------ move / delete / rename gates (0.11.1) ------------------------

    [Fact]
    public async Task GranteeMove_DeniedWithoutMoveTiles_MessageNamesIt()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true, pages: true, charts: true, delete: true);
        ActAs(Grantee);

        var result = await _service.UpdateAsync(id, SaveRequest(layout: MoveTile(TwoTileLayout)), CancellationToken.None);

        Assert.Equal("rcd.dashboard.permission_denied", result.Error!.Code);
        Assert.Contains("moving or resizing tiles", result.Error.Message);
    }

    [Fact]
    public async Task GranteeChartTileRemoval_NeedsChartsAndDeleteFlags()
    {
        var id = await CreateOwnedDashboardAsync();

        // Charts alone: the removal is charts-class but the delete gate is missing.
        await ShareWithAsync(id, Grantee, charts: true);
        ActAs(Grantee);
        var withoutDelete = await _service.UpdateAsync(id, SaveRequest(layout: TextTileOnlyLayout), CancellationToken.None);
        Assert.Equal("rcd.dashboard.permission_denied", withoutDelete.Error!.Code);
        Assert.Contains("removing tiles or pages", withoutDelete.Error.Message);

        // Delete alone: the charts-class flag is missing (delete narrows, never widens).
        ActAs(Owner);
        await ShareWithAsync(id, Grantee, delete: true);
        ActAs(Grantee);
        var withoutCharts = await _service.UpdateAsync(id, SaveRequest(layout: TextTileOnlyLayout), CancellationToken.None);
        Assert.Equal("rcd.dashboard.permission_denied", withoutCharts.Error!.Code);
        Assert.Contains("chart changes", withoutCharts.Error.Message);

        // Both: allowed.
        ActAs(Owner);
        await ShareWithAsync(id, Grantee, charts: true, delete: true);
        ActAs(Grantee);
        var withBoth = await _service.UpdateAsync(id, SaveRequest(layout: TextTileOnlyLayout), CancellationToken.None);
        Assert.True(withBoth.Succeeded, withBoth.Error?.Message);
    }

    [Fact]
    public async Task GranteeTextTileRemoval_NeedsLayoutAndDeleteFlags()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true);
        ActAs(Grantee);

        var withoutDelete = await _service.UpdateAsync(id, SaveRequest(layout: ChartTileOnlyLayout), CancellationToken.None);
        Assert.Equal("rcd.dashboard.permission_denied", withoutDelete.Error!.Code);
        Assert.Contains("removing tiles or pages", withoutDelete.Error.Message);

        ActAs(Owner);
        await ShareWithAsync(id, Grantee, layout: true, delete: true);
        ActAs(Grantee);
        var withBoth = await _service.UpdateAsync(id, SaveRequest(layout: ChartTileOnlyLayout), CancellationToken.None);
        Assert.True(withBoth.Succeeded, withBoth.Error?.Message);
    }

    [Fact]
    public async Task GranteePageRemoval_NeedsPagesAndDeleteFlags()
    {
        var id = await CreateOwnedDashboardAsync(layout: TwoPageLayout);

        await ShareWithAsync(id, Grantee, pages: true);
        ActAs(Grantee);
        var withoutDelete = await _service.UpdateAsync(id, SaveRequest(layout: TwoTileLayout), CancellationToken.None);
        Assert.Equal("rcd.dashboard.permission_denied", withoutDelete.Error!.Code);
        Assert.Contains("removing tiles or pages", withoutDelete.Error.Message);

        ActAs(Owner);
        await ShareWithAsync(id, Grantee, pages: true, delete: true);
        ActAs(Grantee);
        var withBoth = await _service.UpdateAsync(id, SaveRequest(layout: TwoTileLayout), CancellationToken.None);
        Assert.True(withBoth.Succeeded, withBoth.Error?.Message);
    }

    [Fact]
    public async Task GranteeChartRename_DeniedEvenWithEveryFlag()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true, pages: true, charts: true, move: true, delete: true);
        ActAs(Grantee);

        var result = await _service.UpdateAsync(id, SaveRequest(layout: RenameChart(TwoTileLayout)), CancellationToken.None);

        Assert.Equal("rcd.dashboard.permission_denied", result.Error!.Code);
        Assert.Contains("renaming charts", result.Error.Message);
    }

    [Fact]
    public async Task OwnerChartRename_Succeeds_AndAccessCarriesNewFlags()
    {
        var id = await CreateOwnedDashboardAsync();

        var renamed = await _service.UpdateAsync(id, SaveRequest(layout: RenameChart(TwoTileLayout)), CancellationToken.None);
        Assert.True(renamed.Succeeded, renamed.Error?.Message);

        var access = renamed.Value!.MyAccess;
        Assert.True(access is { CanMoveTiles: true, CanDeleteContent: true });
    }

    [Fact]
    public async Task GranteeDenied_MessageNamesTheMissingClass()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true);
        ActAs(Grantee);

        var result = await _service.UpdateAsync(id, SaveRequest(layout: RenamePage(TwoTileLayout)), CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("rcd.dashboard.permission_denied", result.Error!.Code);
        Assert.Contains("page changes", result.Error.Message);
    }

    [Theory]
    [InlineData("New Name", "desc", null)]
    [InlineData("Board", "changed description", null)]
    [InlineData("Board", "desc", 42)]
    public async Task GranteeCannotChangeForbiddenFields(string name, string? description, int? modelId)
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true, pages: true, charts: true);
        ActAs(Grantee);

        var result = await _service.UpdateAsync(
            id, SaveRequest(name, description, modelId), CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("rcd.dashboard.share_forbidden_fields", result.Error!.Code);
    }

    [Fact]
    public async Task GranteeCannotTogglePublish()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true, pages: true, charts: true);
        ActAs(Grantee);

        var result = await _service.UpdateAsync(id, SaveRequest(isShared: true), CancellationToken.None);

        Assert.Equal("rcd.dashboard.share_forbidden_fields", result.Error!.Code);
    }

    [Fact]
    public async Task GranteeWithAllFlags_CanRestructureLayout()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true, pages: true, charts: true, move: true, delete: true);
        ActAs(Grantee);

        var result = await _service.UpdateAsync(
            id, SaveRequest(layout: EditChart(MoveTile(RenamePage(TwoTileLayout)))), CancellationToken.None);

        Assert.True(result.Succeeded, result.Error?.Message);
    }

    [Fact]
    public async Task PublishOnlyViewerCannotSave()
    {
        ActAs(Owner, admin: true);
        var created = await _service.CreateAsync(
            SaveRequest(isShared: true) with { LayoutJson = TwoTileLayout }, CancellationToken.None);
        var id = created.Value!.Id;

        ActAs(Bystander);
        var result = await _service.UpdateAsync(id, SaveRequest(layout: MoveTile(TwoTileLayout), isShared: true), CancellationToken.None);

        Assert.Equal("rcd.dashboard.forbidden", result.Error!.Code);
    }

    // ---------------------------- delete semantics ----------------------------

    [Fact]
    public async Task DeleteByOwner_SoftDeletes_AndKeepsShareRows()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee);

        var deleted = await _service.DeleteAsync(id, CancellationToken.None);

        Assert.True(deleted.Succeeded);
        Assert.True(_harness.Db.Dashboards.Single(d => d.Id == id).IsDeleted);
        Assert.Equal(1, _harness.Db.DashboardShares.Count(s => s.DashboardId == id));
    }

    [Fact]
    public async Task DeleteByGrantee_OnlyRemovesTheirShareRow()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee);

        ActAs(Grantee);
        var deleted = await _service.DeleteAsync(id, CancellationToken.None);

        Assert.True(deleted.Succeeded);
        Assert.False(_harness.Db.Dashboards.Single(d => d.Id == id).IsDeleted);
        Assert.Empty(_harness.Db.DashboardShares.Where(s => s.DashboardId == id));
        Assert.Contains(_harness.Db.DashboardActivity, a => a.DashboardId == id && a.Action == "left" && a.UserId == Grantee);

        // The private dashboard is no longer visible to them.
        Assert.Equal("rcd.dashboard.not_found", (await _service.GetAsync(id, CancellationToken.None)).Error!.Code);
    }

    [Fact]
    public async Task DeleteByPublishOnlyViewer_IsForbidden()
    {
        ActAs(Owner, admin: true);
        var created = await _service.CreateAsync(SaveRequest(isShared: true), CancellationToken.None);
        var id = created.Value!.Id;

        ActAs(Bystander);
        var result = await _service.DeleteAsync(id, CancellationToken.None);

        Assert.Equal("rcd.dashboard.forbidden", result.Error!.Code);
        Assert.False(_harness.Db.Dashboards.Single(d => d.Id == id).IsDeleted);
    }

    [Fact]
    public async Task LeaveRemovesOwnShareRow_ButOwnerHasNothingToLeave()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee);

        var ownerLeave = await _service.LeaveAsync(id, CancellationToken.None);
        Assert.Equal("rcd.dashboard.forbidden", ownerLeave.Error!.Code);

        ActAs(Grantee);
        var left = await _service.LeaveAsync(id, CancellationToken.None);
        Assert.True(left.Succeeded);
        Assert.Empty(_harness.Db.DashboardShares.Where(s => s.DashboardId == id));
    }

    // ------------------------------ share admin ------------------------------

    [Fact]
    public async Task ReplaceShares_AppliesAddsChangesAndRemovals_WithActivity()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, "user-a", layout: true);
        await ShareWithAsync(id, "user-a", layout: true); // no-op replace: no activity

        var result = await _service.ReplaceSharesAsync(
            id,
            [
                new DashboardShareGrant("user-b", false, false, true),
            ],
            CancellationToken.None);

        Assert.True(result.Succeeded);
        var share = Assert.Single(result.Value!);
        Assert.Equal("user-b", share.UserId);
        Assert.True(share.CanEditCharts);

        var activity = _harness.Db.DashboardActivity.Where(a => a.DashboardId == id).ToList();
        Assert.Contains(activity, a => a.Action == "shared" && a.DetailJson!.Contains("user-a"));
        Assert.Contains(activity, a => a.Action == "shared" && a.DetailJson!.Contains("user-b"));
        Assert.Contains(activity, a => a.Action == "unshared" && a.DetailJson!.Contains("user-a"));
        Assert.Single(activity, a => a.Action == "shared" && a.DetailJson!.Contains("user-a"));
    }

    [Fact]
    public async Task ShareInfos_RoundTripNewFlags_AndCarryGrantProvenance()
    {
        var id = await CreateOwnedDashboardAsync();

        var result = await _service.ReplaceSharesAsync(
            id,
            [new DashboardShareGrant(Grantee, true, false, false, CanMoveTiles: true, CanDeleteContent: true)],
            CancellationToken.None);

        Assert.True(result.Succeeded, result.Error?.Message);
        var share = Assert.Single(result.Value!);
        Assert.True(share is { CanEditLayout: true, CanManagePages: false, CanMoveTiles: true, CanDeleteContent: true });
        // "granted by X on date": the granter id travels (display name falls
        // back to the id under the null directory) with the grant timestamp.
        Assert.Equal(Owner, share.GrantedByUserId);
        Assert.Equal(Owner, share.GrantedByDisplayName);
        Assert.NotEqual(default, share.CreatedAtUtc);
    }

    [Fact]
    public async Task ReplaceShares_FlagChangeWritesShareChanged()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true);
        await ShareWithAsync(id, Grantee, layout: true, charts: true);

        Assert.Contains(
            _harness.Db.DashboardActivity,
            a => a.DashboardId == id && a.Action == "shareChanged" && a.DetailJson!.Contains(Grantee));
    }

    [Theory]
    [InlineData(Owner)]     // the owner as target
    [InlineData("")]        // empty target
    public async Task ReplaceShares_InvalidTargetRejected(string target)
    {
        var id = await CreateOwnedDashboardAsync();

        var result = await _service.ReplaceSharesAsync(
            id, [new DashboardShareGrant(target, true, false, false)], CancellationToken.None);

        Assert.Equal("rcd.dashboard.share_target_invalid", result.Error!.Code);
    }

    [Fact]
    public async Task ReplaceShares_AdminCallerAsTargetAndDuplicatesRejected()
    {
        var id = await CreatePublishedDashboardAsync();
        ActAs(Bystander, admin: true);

        var self = await _service.ReplaceSharesAsync(
            id, [new DashboardShareGrant(Bystander, true, false, false)], CancellationToken.None);
        Assert.Equal("rcd.dashboard.share_target_invalid", self.Error!.Code);

        var duplicated = await _service.ReplaceSharesAsync(
            id,
            [new DashboardShareGrant(Grantee, true, false, false), new DashboardShareGrant(Grantee, false, false, false)],
            CancellationToken.None);
        Assert.Equal("rcd.dashboard.share_target_invalid", duplicated.Error!.Code);
    }

    [Fact]
    public async Task SharesReadableAndWritableOnlyByOwnerOrAdmin()
    {
        var id = await CreatePublishedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true);

        ActAs(Grantee);
        Assert.Equal("rcd.dashboard.forbidden", (await _service.GetSharesAsync(id, CancellationToken.None)).Error!.Code);
        var write = await _service.ReplaceSharesAsync(
            id, [new DashboardShareGrant(Bystander, true, false, false)], CancellationToken.None);
        Assert.Equal("rcd.dashboard.forbidden", write.Error!.Code);

        ActAs(Bystander, admin: true);
        Assert.True((await _service.GetSharesAsync(id, CancellationToken.None)).Succeeded);
    }

    // ---------------------------- system read-only ----------------------------

    private async Task<int> SeedSystemDashboardAsync()
    {
        var record = new DashboardRecord
        {
            Name = "Built-in Overview",
            LayoutJson = TwoTileLayout,
            OwnerUserId = "system",
            IsShared = true,
            CreatedAtUtc = DateTime.UtcNow,
            UpdatedAtUtc = DateTime.UtcNow,
        };
        _harness.Db.Dashboards.Add(record);
        await _harness.Db.SaveChangesAsync();
        return record.Id;
    }

    [Fact]
    public async Task SystemDashboard_UpdateDeleteShareAllReadOnly_EvenForAdmins()
    {
        var id = await SeedSystemDashboardAsync();
        ActAs(Owner, admin: true);

        var update = await _service.UpdateAsync(id, SaveRequest("Built-in Overview", isShared: true), CancellationToken.None);
        Assert.Equal("rcd.dashboard.system_readonly", update.Error!.Code);

        var delete = await _service.DeleteAsync(id, CancellationToken.None);
        Assert.Equal("rcd.dashboard.system_readonly", delete.Error!.Code);

        var share = await _service.ReplaceSharesAsync(
            id, [new DashboardShareGrant(Grantee, true, false, false)], CancellationToken.None);
        Assert.Equal("rcd.dashboard.system_readonly", share.Error!.Code);
    }

    [Fact]
    public async Task SystemDashboard_IsSystemFlagSet_AndNoEditAccess()
    {
        var id = await SeedSystemDashboardAsync();
        ActAs(Owner, admin: true);

        var summary = Assert.Single(await _service.ListVisibleAsync(CancellationToken.None), d => d.Id == id);
        Assert.True(summary.IsSystem);
        Assert.False(summary.MyAccess.CanEdit);
    }

    [Fact]
    public async Task SystemDashboard_DuplicateStillAllowedForViewers()
    {
        var id = await SeedSystemDashboardAsync();
        ActAs(Bystander);

        var copy = await _service.DuplicateAsync(id, CancellationToken.None);

        Assert.True(copy.Succeeded, copy.Error?.Message);
        Assert.Equal("Built-in Overview (copy)", copy.Value!.Name);
        Assert.True(copy.Value.OwnerIsMe);
        Assert.False(copy.Value.IsSystem);
        Assert.False(copy.Value.IsShared);
    }

    [Fact]
    public async Task SystemModel_UpdateAndDeleteReadOnly_ButDuplicateAllowed()
    {
        var definition = ModelJson.Serialize(TestFixtures.BuildValidDemoModel());
        var record = new DataModelRecord
        {
            Name = "Built-in Model",
            DataSourceName = TestFixtures.DemoConnectionName,
            DefinitionJson = definition,
            OwnerUserId = "system",
            IsShared = true,
            CreatedAtUtc = DateTime.UtcNow,
            UpdatedAtUtc = DateTime.UtcNow,
        };
        _harness.Db.DataModels.Add(record);
        await _harness.Db.SaveChangesAsync();

        var models = _harness.CreateDataModelService();
        ActAs(Owner, admin: true);

        var update = await models.UpdateAsync(
            record.Id,
            new ModelSaveRequest("Built-in Model", null, TestFixtures.DemoConnectionName, definition, IsShared: true),
            CancellationToken.None);
        Assert.Equal("rcd.model.system_readonly", update.Error!.Code);

        var delete = await models.DeleteAsync(record.Id, CancellationToken.None);
        Assert.Equal("rcd.model.system_readonly", delete.Error!.Code);

        ActAs(Bystander);
        var copy = await models.DuplicateAsync(record.Id, CancellationToken.None);
        Assert.True(copy.Succeeded, copy.Error?.Message);
        Assert.Equal("Built-in Model (copy)", copy.Value!.Name);
    }

    // ------------------------------- activity -------------------------------

    [Fact]
    public async Task LifecycleWritesActivity_CreatedSavedRenamedDeleted()
    {
        var id = await CreateOwnedDashboardAsync();
        await _service.UpdateAsync(id, SaveRequest(layout: MoveTile(TwoTileLayout)), CancellationToken.None);
        await _service.UpdateAsync(id, SaveRequest("Board v2", layout: MoveTile(TwoTileLayout)), CancellationToken.None);
        await _service.DeleteAsync(id, CancellationToken.None);

        var actions = _harness.Db.DashboardActivity
            .Where(a => a.DashboardId == id)
            .OrderBy(a => a.Id)
            .Select(a => a.Action)
            .ToList();
        Assert.Equal(["created", "saved", "renamed", "deleted"], actions);

        var saved = _harness.Db.DashboardActivity.Single(a => a.DashboardId == id && a.Action == "saved");
        // The lifecycle's layout change is a tile MOVE — geometry class since 0.11.1.
        Assert.Contains("\"geometryChanged\":true", saved.DetailJson);
        Assert.Contains("\"layoutChanged\":false", saved.DetailJson);
        Assert.Contains("\"chartsChanged\":false", saved.DetailJson);

        var renamed = _harness.Db.DashboardActivity.Single(a => a.DashboardId == id && a.Action == "renamed");
        Assert.Contains("Board v2", renamed.DetailJson);
    }

    [Fact]
    public async Task DuplicateWritesDuplicatedOnSource_AndCreatedOnCopy()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee);

        ActAs(Grantee);
        var copy = await _service.DuplicateAsync(id, CancellationToken.None);
        Assert.True(copy.Succeeded);

        Assert.Contains(_harness.Db.DashboardActivity,
            a => a.DashboardId == id && a.Action == "duplicated" && a.UserId == Grantee);
        Assert.Contains(_harness.Db.DashboardActivity,
            a => a.DashboardId == copy.Value!.Id && a.Action == "created" && a.UserId == Grantee);
    }

    [Fact]
    public async Task ActivityVisibleToEditRightsHoldersOnly()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, charts: true);
        await ShareWithAsync(id, Grantee, charts: true); // keep single grant
        await _service.ReplaceSharesAsync(
            id,
            [new DashboardShareGrant(Grantee, false, false, true), new DashboardShareGrant(Bystander, false, false, false)],
            CancellationToken.None);

        Assert.True((await _service.ListActivityAsync(id, null, null, CancellationToken.None)).Succeeded);

        ActAs(Grantee);
        var granteeView = await _service.ListActivityAsync(id, null, null, CancellationToken.None);
        Assert.True(granteeView.Succeeded);

        ActAs(Bystander); // view-only grantee
        var viewOnly = await _service.ListActivityAsync(id, null, null, CancellationToken.None);
        Assert.Equal("rcd.dashboard.forbidden", viewOnly.Error!.Code);
    }

    [Fact]
    public async Task ActivityPagination_LimitAndBeforeId()
    {
        var id = await CreateOwnedDashboardAsync();
        for (var i = 0; i < 5; i++)
        {
            var layout = TwoTileLayout.Replace("\"x\":0", $"\"x\":{i + 1}");
            Assert.True((await _service.UpdateAsync(id, SaveRequest(layout: layout), CancellationToken.None)).Succeeded);
        }

        var firstPage = (await _service.ListActivityAsync(id, 3, null, CancellationToken.None)).Value!;
        Assert.Equal(3, firstPage.Count);
        Assert.True(firstPage[0].Id > firstPage[1].Id);

        var secondPage = (await _service.ListActivityAsync(id, 3, firstPage[^1].Id, CancellationToken.None)).Value!;
        Assert.NotEmpty(secondPage);
        Assert.All(secondPage, e => Assert.True(e.Id < firstPage[^1].Id));
    }

    [Fact]
    public async Task ActivityTrimsToNewest500PerDashboard()
    {
        var id = await CreateOwnedDashboardAsync();
        var backfill = Enumerable.Range(0, 520)
            .Select(i => new DashboardActivityRecord
            {
                DashboardId = id,
                UserId = Owner,
                Action = "saved",
                AtUtc = DateTime.UtcNow.AddMinutes(-520 + i),
            })
            .ToList();
        _harness.Db.DashboardActivity.AddRange(backfill);
        await _harness.Db.SaveChangesAsync();

        // Any activity-writing action triggers the trim.
        var update = await _service.UpdateAsync(id, SaveRequest(layout: MoveTile(TwoTileLayout)), CancellationToken.None);
        Assert.True(update.Succeeded);

        var remaining = await _harness.Db.DashboardActivity
            .Where(a => a.DashboardId == id)
            .OrderByDescending(a => a.Id)
            .ToListAsync();
        Assert.Equal(DashboardService.MaxActivityEntriesPerDashboard, remaining.Count);

        // Newest survived: the very last write is present, the oldest ids are gone.
        Assert.Equal("saved", remaining[0].Action);
        var oldestKept = remaining[^1].Id;
        Assert.DoesNotContain(_harness.Db.DashboardActivity.AsEnumerable(), a => a.Id < oldestKept && a.DashboardId == id);
    }

    [Fact]
    public async Task ActivityEntriesEchoUserIdAsDisplayName_WithNullDirectory()
    {
        var id = await CreateOwnedDashboardAsync();

        var entries = (await _service.ListActivityAsync(id, null, null, CancellationToken.None)).Value!;
        var created = Assert.Single(entries);
        Assert.Equal(Owner, created.UserId);
        Assert.Equal(Owner, created.DisplayName);
    }
}
