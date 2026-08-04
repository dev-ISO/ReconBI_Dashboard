using System.Text.Json;
using ReconDashboards.Core.Services;

namespace ReconDashboards.Core.Tests;

public class DashboardServiceTests : IDisposable
{
    private readonly ServiceTestHarness _harness = new();
    private readonly DashboardService _service;

    public DashboardServiceTests()
    {
        _service = _harness.CreateDashboardService();
    }

    public void Dispose() => _harness.Dispose();

    private static DashboardSaveRequest Request(
        string name,
        string layoutJson = """{"tiles":[]}""",
        bool isShared = false,
        DateTime? expectedUpdatedAtUtc = null) =>
        new(name, "A demo dashboard", ModelId: null, layoutJson, isShared, expectedUpdatedAtUtc);

    [Fact]
    public async Task CreateThenGetRoundTripsTheDashboard()
    {
        var created = await _service.CreateAsync(
            Request("Sales Overview", layoutJson: """{"tiles":[{"kind":"bar"}]}"""), CancellationToken.None);

        Assert.True(created.Succeeded);

        var fetched = await _service.GetAsync(created.Value!.Id, CancellationToken.None);

        Assert.True(fetched.Succeeded);
        var detail = fetched.Value!;
        Assert.Equal("Sales Overview", detail.Name);
        Assert.True(detail.OwnerIsMe);
        Assert.Equal(JsonValueKind.Object, detail.Layout.ValueKind);
        Assert.Equal(1, detail.Layout.GetProperty("tiles").GetArrayLength());
    }

    [Fact]
    public async Task ListShowsOwnAndOthersSharedDashboardsButHidesOthersPrivateDashboards()
    {
        await _service.CreateAsync(Request("My Board"), CancellationToken.None);

        _harness.CurrentUser.UserId = "user-2";
        _harness.CurrentUser.CanManageShared = true;
        await _service.CreateAsync(Request("Their Shared Board", isShared: true), CancellationToken.None);
        await _service.CreateAsync(Request("Their Private Board"), CancellationToken.None);

        _harness.CurrentUser.UserId = "user-1";
        _harness.CurrentUser.CanManageShared = false;
        var visible = await _service.ListVisibleAsync(CancellationToken.None);

        Assert.Equal(2, visible.Count);
        Assert.True(Assert.Single(visible, d => d.Name == "My Board").OwnerIsMe);
        Assert.False(Assert.Single(visible, d => d.Name == "Their Shared Board").OwnerIsMe);
        Assert.DoesNotContain(visible, d => d.Name == "Their Private Board");
    }

    [Fact]
    public async Task UpdateChangesNameAndLayout()
    {
        var created = await _service.CreateAsync(Request("Draft Board"), CancellationToken.None);
        Assert.True(created.Succeeded);

        var updated = await _service.UpdateAsync(
            created.Value!.Id,
            Request("Final Board", layoutJson: """{"tiles":[{"kind":"line"},{"kind":"pie"}]}"""),
            CancellationToken.None);

        Assert.True(updated.Succeeded);
        Assert.Equal("Final Board", updated.Value!.Name);
        Assert.Equal(2, updated.Value.Layout.GetProperty("tiles").GetArrayLength());
    }

    [Fact]
    public async Task DeleteSoftDeletesAndHidesFromListAndGet()
    {
        var created = await _service.CreateAsync(Request("Disposable Board"), CancellationToken.None);
        Assert.True(created.Succeeded);

        var deleted = await _service.DeleteAsync(created.Value!.Id, CancellationToken.None);
        Assert.True(deleted.Succeeded);

        var visible = await _service.ListVisibleAsync(CancellationToken.None);
        Assert.DoesNotContain(visible, d => d.Id == created.Value.Id);

        var fetched = await _service.GetAsync(created.Value.Id, CancellationToken.None);
        Assert.False(fetched.Succeeded);
        Assert.Equal("rcd.dashboard.not_found", fetched.Error!.Code);

        var record = _harness.Db.Dashboards.Single(d => d.Id == created.Value.Id);
        Assert.True(record.IsDeleted);
    }

    [Fact]
    public async Task DuplicateOfSharedOtherUserDashboardBecomesCallerOwnedCopy()
    {
        _harness.CurrentUser.UserId = "owner-user";
        _harness.CurrentUser.CanManageShared = true;
        var shared = await _service.CreateAsync(
            Request("Team Board", layoutJson: """{"tiles":[{"kind":"kpi"}]}""", isShared: true),
            CancellationToken.None);
        Assert.True(shared.Succeeded);

        _harness.CurrentUser.UserId = "copier-user";
        _harness.CurrentUser.CanManageShared = false;
        var copy = await _service.DuplicateAsync(shared.Value!.Id, CancellationToken.None);

        Assert.True(copy.Succeeded);
        var detail = copy.Value!;
        Assert.Equal("Team Board (copy)", detail.Name);
        Assert.True(detail.OwnerIsMe);
        Assert.False(detail.IsShared);
        Assert.Equal(1, detail.Layout.GetProperty("tiles").GetArrayLength());

        var record = _harness.Db.Dashboards.Single(d => d.Id == detail.Id);
        Assert.Equal("copier-user", record.OwnerUserId);
    }

    [Fact]
    public async Task MalformedLayoutJsonIsRejectedAsInvalidLayout()
    {
        var result = await _service.CreateAsync(
            Request("Broken Board", layoutJson: "{ this is not json"), CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal(ServiceErrorKind.BadRequest, result.Error!.Kind);
        Assert.Equal("rcd.dashboard.invalid_layout", result.Error.Code);
    }

    [Fact]
    public async Task NonObjectLayoutRootIsRejectedAsInvalidLayout()
    {
        var result = await _service.CreateAsync(
            Request("Array Board", layoutJson: "[1,2,3]"), CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal(ServiceErrorKind.BadRequest, result.Error!.Kind);
        Assert.Equal("rcd.dashboard.invalid_layout", result.Error.Code);
    }

    [Fact]
    public async Task DuplicateNameForSameOwnerIsRejectedAsNameConflict()
    {
        var first = await _service.CreateAsync(Request("Unique Board"), CancellationToken.None);
        Assert.True(first.Succeeded);

        var duplicate = await _service.CreateAsync(Request("Unique Board"), CancellationToken.None);

        Assert.False(duplicate.Succeeded);
        Assert.Equal(ServiceErrorKind.Conflict, duplicate.Error!.Kind);
        Assert.Equal("rcd.dashboard.name_conflict", duplicate.Error.Code);
    }

    [Fact]
    public async Task MaxDashboardsPerUserLimitIsEnforced()
    {
        _harness.Options.Limits.MaxDashboardsPerUser = 1;

        var first = await _service.CreateAsync(Request("Only Board"), CancellationToken.None);
        Assert.True(first.Succeeded);

        var second = await _service.CreateAsync(Request("One Too Many"), CancellationToken.None);

        Assert.False(second.Succeeded);
        Assert.Equal(ServiceErrorKind.LimitExceeded, second.Error!.Kind);
        Assert.Equal("rcd.limit.dashboards", second.Error.Code);
    }
}
