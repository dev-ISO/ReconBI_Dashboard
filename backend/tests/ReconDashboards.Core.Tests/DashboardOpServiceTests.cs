using Microsoft.EntityFrameworkCore;
using ReconDashboards.Core.Abstractions;
using ReconDashboards.Core.Persistence;
using ReconDashboards.Core.Services;

namespace ReconDashboards.Core.Tests;

/// <summary>
/// COLLAB wave 1 ops endpoint engine: classification parity with the differ
/// (every differ scenario re-expressed as an op), per-class permission gating
/// incl. the owner-only rename and the move/delete gates, soft-lock advisory,
/// idempotent replays, and the post-commit broadcast.
/// </summary>
public class DashboardOpServiceTests : IDisposable
{
    private const string Owner = "owner-user";
    private const string Grantee = "grantee-user";
    private const string Bystander = "bystander-user";

    /// <summary>Mirrors the differ tests' BaseDoc so parity cases translate 1:1.</summary>
    private const string BaseLayout = """
        {"pages":[
          {"id":"p1","name":"Overview","color":"#ff0000","tiles":[
            {"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},
             "chart":{"id":"c1","type":"column","title":"Orders by Region","query":{"measures":[{"name":"Total"}]},"format":{"palette":"a"}}},
            {"id":"t2","kind":"slicer","layout":{"x":4,"y":0,"w":2,"h":1},"slicer":{"table":"public.orders","column":"status"}}]},
          {"id":"p2","name":"Detail","tiles":[]}],
         "refreshSeconds":60,
         "filterCards":[{"id":"f1","scope":"allPages"}],
         "measures":[{"id":"m1","name":"Revenue","table":"public.orders","aggregation":"sum","column":"order_total"}]}
        """;

    private static readonly DateTimeOffset Start = new(2026, 8, 19, 12, 0, 0, TimeSpan.Zero);

    private readonly ServiceTestHarness _harness = new();
    private readonly DashboardService _dashboards;
    private readonly DashboardOpService _ops;
    private readonly DashboardTileLockService _locks;
    private readonly RecordingOpNotifier _notifier = new();
    private readonly MutableTimeProvider _clock = new(Start);

    public DashboardOpServiceTests()
    {
        _dashboards = _harness.CreateDashboardService();
        _locks = new DashboardTileLockService(_clock);
        _ops = _harness.CreateDashboardOpService(_locks, _notifier, _clock);
        _harness.CurrentUser.UserId = Owner;
    }

    public void Dispose() => _harness.Dispose();

    private void ActAs(string userId, bool admin = false)
    {
        _harness.CurrentUser.UserId = userId;
        _harness.CurrentUser.CanManageShared = admin;
    }

    private async Task<int> CreateOwnedDashboardAsync(string? layout = null)
    {
        var created = await _dashboards.CreateAsync(
            new DashboardSaveRequest("Board", "desc", ModelId: null, layout ?? BaseLayout),
            CancellationToken.None);
        Assert.True(created.Succeeded, created.Error?.Message);
        return created.Value!.Id;
    }

    private async Task ShareWithAsync(
        int id, string userId,
        bool layout = false, bool pages = false, bool charts = false,
        bool move = false, bool delete = false)
    {
        var result = await _dashboards.ReplaceSharesAsync(
            id, [new DashboardShareGrant(userId, layout, pages, charts, move, delete)], CancellationToken.None);
        Assert.True(result.Succeeded, result.Error?.Message);
    }

    private Task<ServiceResult<DashboardOpResult>> ApplyAsync(
        int id, string targetKind, string? targetId, string payload, string? opId = null) =>
        _ops.ApplyAsync(
            id,
            new DashboardOpSubmission(opId ?? Guid.NewGuid().ToString("N"), targetKind, targetId, payload),
            CancellationToken.None);

    private string StoredLayout(int id) =>
        _harness.Db.Dashboards.AsNoTracking().Single(d => d.Id == id).LayoutJson;

    private DateTime StoredStamp(int id) =>
        _harness.Db.Dashboards.AsNoTracking().Single(d => d.Id == id).UpdatedAtUtc;

    // ------------------- classification parity with the differ -------------------
    // Every differ scenario as an op: the op is applied, then the differ judges
    // old vs stored — the flags must match what the equivalent whole-doc save
    // would have been gated on, and the wire class must be the dominant one.

    public static TheoryData<string, string, string?, string, string> ParityCases() => new()
    {
        // name, targetKind, targetId, payload, expected differ flags
        {
            "TileMoved_GeometryOnly", "tile", "t1",
            """{"kind":"tileGeometry","layout":{"x":2,"y":1,"w":4,"h":3}}""",
            "geometry"
        },
        {
            "ChartBodyEdited_ChartsOnly", "tile", "t1",
            """{"kind":"tileUpsert","tile":{"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},"chart":{"id":"c1","type":"line","title":"Orders by Region","query":{"measures":[{"name":"Total"}]},"format":{"palette":"a"}}}}""",
            "charts"
        },
        {
            "ChartRetitled_RenameOnly", "tile", "t1",
            """{"kind":"tileUpsert","tile":{"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},"chart":{"id":"c1","type":"column","title":"Orders by Area","query":{"measures":[{"name":"Total"}]},"format":{"palette":"a"}}}}""",
            "renamed"
        },
        {
            "SlicerEdited_LayoutOnly", "tile", "t2",
            """{"kind":"tileUpsert","tile":{"id":"t2","kind":"slicer","layout":{"x":4,"y":0,"w":2,"h":1},"slicer":{"table":"public.orders","column":"order_date"}}}""",
            "layout"
        },
        {
            "ChartTileAdded_ChartsOnly", "tile", "t3",
            """{"kind":"tileUpsert","pageId":"p2","tile":{"id":"t3","kind":"chart","chart":{"title":"New"}}}""",
            "charts"
        },
        {
            "TextTileAdded_LayoutOnly", "tile", "t9",
            """{"kind":"tileUpsert","pageId":"p2","tile":{"id":"t9","kind":"text","text":{"html":"<p>x</p>"}}}""",
            "layout"
        },
        {
            "ChartTileRemoved_ChartsAndRemoval", "tile", "t1",
            """{"kind":"tileRemove"}""",
            "charts,removal"
        },
        {
            "SlicerTileRemoved_LayoutAndRemoval", "tile", "t2",
            """{"kind":"tileRemove"}""",
            "layout,removal"
        },
        {
            "EmptyPageAdded_PagesOnly", "page", "p3",
            """{"kind":"pageAdd","page":{"id":"p3","name":"Costs","tiles":[]}}""",
            "pages"
        },
        {
            "PageAddedWithChartTile_PagesAndCharts", "page", "p3",
            """{"kind":"pageAdd","page":{"id":"p3","name":"Costs","tiles":[{"id":"t9","kind":"chart"}]}}""",
            "pages,charts"
        },
        {
            "PageRenamed_PagesOnly", "page", "p2",
            """{"kind":"pageRename","name":"Deep Dive"}""",
            "pages"
        },
        {
            "PageRecolored_PagesOnly", "page", "p1",
            """{"kind":"pageColor","color":"#00ff00"}""",
            "pages"
        },
        {
            "PageMobileLayoutSet_PagesOnly", "page", "p1",
            """{"kind":"pageSet","patch":{"mobileLayout":{"order":["t2","t1"]}}}""",
            "pages"
        },
        {
            "PageDrillthroughSet_PagesOnly", "page", "p1",
            """{"kind":"pageSet","patch":{"drillthrough":{"sourceCharts":["c1"]}}}""",
            "pages"
        },
        {
            "PagesReordered_PagesOnly", "doc", null,
            """{"kind":"pageReorder","pageIds":["p2","p1"]}""",
            "pages"
        },
        {
            "EmptyPageRemoved_PagesAndRemoval", "page", "p2",
            """{"kind":"pageRemove"}""",
            "pages,removal"
        },
        {
            "DocSettingChanged_LayoutOnly", "doc", null,
            """{"kind":"docSettingSet","key":"refreshSeconds","value":30}""",
            "layout"
        },
        {
            "UnknownDocKeySet_LayoutOnly", "doc", null,
            """{"kind":"docSettingSet","key":"futureSetting","value":2}""",
            "layout"
        },
        {
            "FilterCardEdited_LayoutOnly", "doc", "f1",
            """{"kind":"docElementUpsert","field":"filterCards","element":{"id":"f1","scope":"page"}}""",
            "layout"
        },
        {
            "FilterCardRemoved_LayoutOnly", "doc", "f1",
            """{"kind":"docElementRemove","field":"filterCards"}""",
            "layout"
        },
        // Dashboard-scoped measures ride the SAME id-keyed element vocabulary
        // as filter cards. Without "measures" in the applier's ElementFields
        // (and the client's DOC_ELEMENT_FIELDS) a live-mode measure edit emits
        // no op at all and is silently lost.
        {
            "DashboardMeasureEdited_LayoutOnly", "doc", "m1",
            """{"kind":"docElementUpsert","field":"measures","element":{"id":"m1","name":"Revenue","table":"public.orders","aggregation":"sum","column":"order_total","formatString":"#,##0"}}""",
            "layout"
        },
        {
            "DashboardMeasureRemoved_LayoutOnly", "doc", "m1",
            """{"kind":"docElementRemove","field":"measures"}""",
            "layout"
        },
    };

    [Theory]
    [MemberData(nameof(ParityCases))]
    public async Task OpClassification_MatchesTheDiffer(
        string name, string targetKind, string? targetId, string payload, string expectedFlags)
    {
        _ = name;
        var id = await CreateOwnedDashboardAsync();

        var result = await ApplyAsync(id, targetKind, targetId, payload);
        Assert.True(result.Succeeded, result.Error?.Message);

        var flags = expectedFlags.Split(',', StringSplitOptions.TrimEntries).ToHashSet(StringComparer.Ordinal);
        var summary = DashboardLayoutDiffer.Diff(BaseLayout, StoredLayout(id));

        Assert.Equal(flags.Contains("layout"), summary.LayoutChanged);
        Assert.Equal(flags.Contains("pages"), summary.PagesChanged);
        Assert.Equal(flags.Contains("charts"), summary.ChartsChanged);
        Assert.Equal(flags.Contains("geometry"), summary.GeometryChanged);
        Assert.Equal(flags.Contains("renamed"), summary.ChartsRenamed.Count > 0);
        Assert.Equal(flags.Contains("removal"), summary.HasRemovals);

        // Wire class = dominant flag (independent oracle of PrimaryClassOf).
        var expectedClass =
            flags.Contains("removal") ? "removal"
            : flags.Contains("charts") || flags.Contains("renamed") ? "charts"
            : flags.Contains("pages") ? "pages"
            : flags.Contains("geometry") ? "geometry"
            : "layout";
        Assert.Equal(expectedClass, result.Value!.Class);

        // The receipt's stamp IS the stored stamp (the client's new baseline).
        Assert.Equal(StoredStamp(id), result.Value.UpdatedAtUtc);
    }

    [Fact]
    public async Task PageRemove_RefusesTheLastPage_SoPagesNeverReachZero()
    {
        const string layout = """{"pages":[{"id":"p1","name":"Only","tiles":[]}]}""";
        var id = await CreateOwnedDashboardAsync(layout);

        var result = await ApplyAsync(id, "page", "p1", """{"kind":"pageRemove"}""");

        // Mirrors the client guard: op_target_missing pushes the sender to
        // refetch, where the surviving page is the truth.
        Assert.False(result.Succeeded);
        Assert.Equal("rcd.dashboard.op_target_missing", result.Error!.Code);
        using var doc = System.Text.Json.JsonDocument.Parse(StoredLayout(id));
        Assert.Equal(1, doc.RootElement.GetProperty("pages").GetArrayLength());
    }

    [Fact]
    public async Task PageRemove_OfAMissingPage_StaysAnIdempotentNoOp_EvenOnASinglePageDoc()
    {
        const string layout = """{"pages":[{"id":"p1","name":"Only","tiles":[]}]}""";
        var id = await CreateOwnedDashboardAsync(layout);

        // The last-page guard applies only when the TARGET exists — a replayed
        // remove of an already-gone page keeps its idempotent success.
        var result = await ApplyAsync(id, "page", "p-gone", """{"kind":"pageRemove"}""");

        Assert.True(result.Succeeded, result.Error?.Message);
        using var doc = System.Text.Json.JsonDocument.Parse(StoredLayout(id));
        Assert.Equal(1, doc.RootElement.GetProperty("pages").GetArrayLength());
    }

    [Fact]
    public async Task PageSet_PatchSemantics_AbsentUntouched_NullClears()
    {
        // Seed with BOTH page scalars present so all three patch states are observable.
        const string layout = """
            {"pages":[{"id":"p1","name":"Main",
              "mobileLayout":{"order":["t1"]},
              "drillthrough":{"sourceCharts":["c1"]},
              "tiles":[{"id":"t1","kind":"text","text":{"content":"hello"}}]}]}
            """;
        var id = await CreateOwnedDashboardAsync(layout);

        // ABSENT key untouched: patching only drillthrough leaves mobileLayout alone.
        var patchOne = await ApplyAsync(id, "page", "p1",
            """{"kind":"pageSet","patch":{"drillthrough":{"sourceCharts":["c1","c2"]}}}""");
        Assert.True(patchOne.Succeeded, patchOne.Error?.Message);
        Assert.Equal("pages", patchOne.Value!.Class);

        using (var doc = System.Text.Json.JsonDocument.Parse(StoredLayout(id)))
        {
            var page = doc.RootElement.GetProperty("pages")[0];
            Assert.Equal("t1", page.GetProperty("mobileLayout").GetProperty("order")[0].GetString());
            Assert.Equal(2, page.GetProperty("drillthrough").GetProperty("sourceCharts").GetArrayLength());
            // Tiles inside the page are untouched — the reason pageSet exists.
            Assert.Equal("hello", page.GetProperty("tiles")[0].GetProperty("text").GetProperty("content").GetString());
        }

        // PRESENT-with-null clears: mobileLayout is REMOVED (absent key, the
        // canonical no-value shape), drillthrough still untouched.
        var patchClear = await ApplyAsync(id, "page", "p1",
            """{"kind":"pageSet","patch":{"mobileLayout":null}}""");
        Assert.True(patchClear.Succeeded, patchClear.Error?.Message);

        using (var doc = System.Text.Json.JsonDocument.Parse(StoredLayout(id)))
        {
            var page = doc.RootElement.GetProperty("pages")[0];
            Assert.False(page.TryGetProperty("mobileLayout", out _));
            Assert.Equal(2, page.GetProperty("drillthrough").GetProperty("sourceCharts").GetArrayLength());
        }
    }

    [Fact]
    public async Task GranteePageSet_RidesThePagesFlag()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true, charts: true, move: true, delete: true); // everything BUT pages
        ActAs(Grantee);

        const string payload = """{"kind":"pageSet","patch":{"mobileLayout":{"order":["t2","t1"]}}}""";
        var denied = await ApplyAsync(id, "page", "p1", payload);
        Assert.Equal("rcd.dashboard.permission_denied", denied.Error!.Code);
        Assert.Contains("page changes", denied.Error.Message);

        ActAs(Owner);
        await ShareWithAsync(id, Grantee, pages: true);
        ActAs(Grantee);
        var allowed = await ApplyAsync(id, "page", "p1", payload);
        Assert.True(allowed.Succeeded, allowed.Error?.Message);
    }

    [Fact]
    public async Task Op_TouchesOnlyItsTarget()
    {
        var id = await CreateOwnedDashboardAsync();

        var result = await ApplyAsync(id, "tile", "t1",
            """{"kind":"tileGeometry","layout":{"x":6,"y":0,"w":4,"h":3}}""");
        Assert.True(result.Succeeded, result.Error?.Message);

        // Everything except t1.layout survives byte-for-byte semantically.
        var summary = DashboardLayoutDiffer.Diff(BaseLayout, StoredLayout(id));
        Assert.True(summary.GeometryChanged);
        Assert.False(summary.LayoutChanged);
        Assert.False(summary.PagesChanged);
        Assert.False(summary.ChartsChanged);
        Assert.False(summary.SettingsChanged);
        Assert.Empty(summary.ChartsRenamed);
    }

    // ------------------------ legacy (pre-pages) documents ------------------------

    private const string LegacyLayout = """
        {"tiles":[{"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},"chart":{"title":"KPIs","type":"kpi"}}],
         "slicers":[{"table":"public.orders","column":"status"}]}
        """;

    [Fact]
    public async Task LegacyDoc_TileOpsWorkOnTopLevelTiles()
    {
        var id = await CreateOwnedDashboardAsync(LegacyLayout);

        var moved = await ApplyAsync(id, "tile", "t1",
            """{"kind":"tileGeometry","layout":{"x":6,"y":0,"w":4,"h":3}}""");
        Assert.True(moved.Succeeded, moved.Error?.Message);
        Assert.Equal("geometry", moved.Value!.Class);

        // Adds need no pageId on a legacy doc — the root tiles[] is the page.
        var added = await ApplyAsync(id, "tile", "t9",
            """{"kind":"tileUpsert","tile":{"id":"t9","kind":"text","text":{"html":"<p>x</p>"}}}""");
        Assert.True(added.Succeeded, added.Error?.Message);
        Assert.Equal("layout", added.Value!.Class);
    }

    [Fact]
    public async Task LegacyDoc_PageOpsAreRefused()
    {
        var id = await CreateOwnedDashboardAsync(LegacyLayout);

        var result = await ApplyAsync(id, "page", "p1",
            """{"kind":"pageAdd","page":{"id":"p1","name":"Page 1","tiles":[]}}""");

        Assert.Equal("rcd.dashboard.op_target_missing", result.Error!.Code);
    }

    // ------------------------------ permission gates ------------------------------

    [Theory]
    [InlineData(true, false, false, false)]
    [InlineData(false, true, false, false)]
    [InlineData(false, false, true, false)]
    [InlineData(false, false, false, true)]
    public async Task GranteeOp_EachFlagCoversExactlyItsClass(bool layout, bool pages, bool charts, bool move)
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout, pages, charts, move);
        ActAs(Grantee);

        var moveResult = await ApplyAsync(id, "tile", "t1",
            """{"kind":"tileGeometry","layout":{"x":6,"y":0,"w":4,"h":3}}""");
        Assert.Equal(move, moveResult.Succeeded);

        var textResult = await ApplyAsync(id, "tile", "t2",
            """{"kind":"tileUpsert","tile":{"id":"t2","kind":"slicer","layout":{"x":4,"y":0,"w":2,"h":1},"slicer":{"table":"public.orders","column":"order_date"}}}""");
        Assert.Equal(layout, textResult.Succeeded);

        var pageResult = await ApplyAsync(id, "page", "p2",
            """{"kind":"pageRename","name":"Renamed"}""");
        Assert.Equal(pages, pageResult.Succeeded);

        var chartResult = await ApplyAsync(id, "tile", "t1",
            """{"kind":"tileUpsert","tile":{"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},"chart":{"id":"c1","type":"line","title":"Orders by Region","query":{"measures":[{"name":"Total"}]},"format":{"palette":"a"}}}}""");
        Assert.Equal(charts, chartResult.Succeeded);

        var denied = new[] { moveResult, textResult, pageResult, chartResult }.First(r => !r.Succeeded);
        Assert.Equal("rcd.dashboard.permission_denied", denied.Error!.Code);
    }

    [Fact]
    public async Task GranteeTileRemoveOp_NeedsClassAndDeleteFlags()
    {
        var id = await CreateOwnedDashboardAsync();

        // Charts alone: removal of a chart tile still needs the delete right.
        await ShareWithAsync(id, Grantee, charts: true);
        ActAs(Grantee);
        var withoutDelete = await ApplyAsync(id, "tile", "t1", """{"kind":"tileRemove"}""");
        Assert.Equal("rcd.dashboard.permission_denied", withoutDelete.Error!.Code);
        Assert.Contains("removing tiles or pages", withoutDelete.Error.Message);

        // Delete alone: the charts-class flag is missing (delete narrows, never widens).
        ActAs(Owner);
        await ShareWithAsync(id, Grantee, delete: true);
        ActAs(Grantee);
        var withoutCharts = await ApplyAsync(id, "tile", "t1", """{"kind":"tileRemove"}""");
        Assert.Equal("rcd.dashboard.permission_denied", withoutCharts.Error!.Code);
        Assert.Contains("chart changes", withoutCharts.Error.Message);

        ActAs(Owner);
        await ShareWithAsync(id, Grantee, charts: true, delete: true);
        ActAs(Grantee);
        var withBoth = await ApplyAsync(id, "tile", "t1", """{"kind":"tileRemove"}""");
        Assert.True(withBoth.Succeeded, withBoth.Error?.Message);
        Assert.Equal("removal", withBoth.Value!.Class);
    }

    [Fact]
    public async Task GranteePageRemoveOp_NeedsPagesAndDeleteFlags()
    {
        var id = await CreateOwnedDashboardAsync();

        await ShareWithAsync(id, Grantee, pages: true);
        ActAs(Grantee);
        var withoutDelete = await ApplyAsync(id, "page", "p2", """{"kind":"pageRemove"}""");
        Assert.Equal("rcd.dashboard.permission_denied", withoutDelete.Error!.Code);
        Assert.Contains("removing tiles or pages", withoutDelete.Error.Message);

        ActAs(Owner);
        await ShareWithAsync(id, Grantee, pages: true, delete: true);
        ActAs(Grantee);
        var withBoth = await ApplyAsync(id, "page", "p2", """{"kind":"pageRemove"}""");
        Assert.True(withBoth.Succeeded, withBoth.Error?.Message);
    }

    [Fact]
    public async Task GranteeRenameOp_DeniedEvenWithEveryFlag_OwnerAndAdminSucceed()
    {
        // Published so the ADMIN leg can see it (visibility = owner/published/share).
        ActAs(Owner, admin: true);
        var created = await _dashboards.CreateAsync(
            new DashboardSaveRequest("Board", "desc", ModelId: null, BaseLayout, IsShared: true),
            CancellationToken.None);
        Assert.True(created.Succeeded, created.Error?.Message);
        var id = created.Value!.Id;
        ActAs(Owner);
        await ShareWithAsync(id, Grantee, layout: true, pages: true, charts: true, move: true, delete: true);

        const string retitle = """{"kind":"tileUpsert","tile":{"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},"chart":{"id":"c1","type":"column","title":"Orders by Area","query":{"measures":[{"name":"Total"}]},"format":{"palette":"a"}}}}""";

        ActAs(Grantee);
        var granteeAttempt = await ApplyAsync(id, "tile", "t1", retitle);
        Assert.Equal("rcd.dashboard.permission_denied", granteeAttempt.Error!.Code);
        Assert.Contains("renaming charts", granteeAttempt.Error.Message);

        ActAs(Bystander, admin: true);
        var adminAttempt = await ApplyAsync(id, "tile", "t1", retitle);
        Assert.True(adminAttempt.Succeeded, adminAttempt.Error?.Message);

        // Owner retitles back (proves the owner path too).
        ActAs(Owner);
        var ownerAttempt = await ApplyAsync(id, "tile", "t1",
            retitle.Replace("Orders by Area", "Orders by Region"));
        Assert.True(ownerAttempt.Succeeded, ownerAttempt.Error?.Message);
    }

    [Fact]
    public async Task PublishOnlyViewerOp_IsForbidden()
    {
        ActAs(Owner, admin: true);
        var created = await _dashboards.CreateAsync(
            new DashboardSaveRequest("Published", "desc", null, BaseLayout, IsShared: true),
            CancellationToken.None);
        var id = created.Value!.Id;

        ActAs(Bystander);
        var result = await ApplyAsync(id, "tile", "t1",
            """{"kind":"tileGeometry","layout":{"x":6,"y":0,"w":4,"h":3}}""");

        Assert.Equal("rcd.dashboard.forbidden", result.Error!.Code);
        Assert.Empty(_notifier.Ops);
    }

    [Fact]
    public async Task InvisibleDashboardOp_IsNotFound()
    {
        var id = await CreateOwnedDashboardAsync();

        ActAs(Bystander);
        var result = await ApplyAsync(id, "tile", "t1",
            """{"kind":"tileGeometry","layout":{"x":6,"y":0,"w":4,"h":3}}""");

        Assert.Equal("rcd.dashboard.not_found", result.Error!.Code);
    }

    [Fact]
    public async Task SystemDashboardOp_IsReadOnly_EvenForAdmins()
    {
        var record = new DashboardRecord
        {
            Name = "Built-in Overview",
            LayoutJson = BaseLayout,
            OwnerUserId = "system",
            IsShared = true,
            CreatedAtUtc = DateTime.UtcNow,
            UpdatedAtUtc = DateTime.UtcNow,
        };
        _harness.Db.Dashboards.Add(record);
        await _harness.Db.SaveChangesAsync();

        ActAs(Owner, admin: true);
        var result = await ApplyAsync(record.Id, "tile", "t1",
            """{"kind":"tileGeometry","layout":{"x":6,"y":0,"w":4,"h":3}}""");

        Assert.Equal("rcd.dashboard.system_readonly", result.Error!.Code);
    }

    // ------------------------------- soft tile locks -------------------------------

    [Fact]
    public async Task OpOnTileLockedByAnother_IsRejected_UntilTtlExpiry()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, charts: true);

        // The grantee locks t1 (chart-builder open).
        ActAs(Grantee);
        var acquired = await _ops.AcquireTileLockAsync(id, "t1", CancellationToken.None);
        Assert.True(acquired.Succeeded, acquired.Error?.Message);

        // The owner's op on the LOCKED tile is rejected, naming the holder…
        ActAs(Owner);
        var blocked = await ApplyAsync(id, "tile", "t1",
            """{"kind":"tileGeometry","layout":{"x":6,"y":0,"w":4,"h":3}}""");
        Assert.Equal("rcd.dashboard.tile_locked", blocked.Error!.Code);
        Assert.Contains(Grantee, blocked.Error.Message);
        Assert.Empty(_notifier.Ops);

        // …while ops on OTHER tiles pass (locks are per tile, not per dashboard).
        var other = await ApplyAsync(id, "tile", "t2",
            """{"kind":"tileGeometry","layout":{"x":5,"y":0,"w":2,"h":1}}""");
        Assert.True(other.Succeeded, other.Error?.Message);

        // The HOLDER's own op on the locked tile passes its class gate as usual.
        ActAs(Grantee);
        var holderEdit = await ApplyAsync(id, "tile", "t1",
            """{"kind":"tileUpsert","tile":{"id":"t1","kind":"chart","layout":{"x":0,"y":0,"w":4,"h":3},"chart":{"id":"c1","type":"line","title":"Orders by Region","query":{"measures":[{"name":"Total"}]},"format":{"palette":"a"}}}}""");
        Assert.True(holderEdit.Succeeded, holderEdit.Error?.Message);

        // After the TTL lapses without a heartbeat the advisory dissolves.
        _clock.Advance(DashboardTileLockService.Ttl + TimeSpan.FromSeconds(1));
        ActAs(Owner);
        var afterExpiry = await ApplyAsync(id, "tile", "t1",
            """{"kind":"tileGeometry","layout":{"x":6,"y":0,"w":4,"h":3}}""");
        Assert.True(afterExpiry.Succeeded, afterExpiry.Error?.Message);
    }

    [Fact]
    public async Task LockAcquire_HeartbeatSameHolder_ConflictForOthers_ReleaseFrees()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee, layout: true);

        var first = await _ops.AcquireTileLockAsync(id, "t1", CancellationToken.None);
        Assert.True(first.Succeeded);
        Assert.Equal(Owner, first.Value!.HolderUserId);

        // Heartbeat: same holder re-acquires, expiry advances.
        _clock.Advance(TimeSpan.FromSeconds(10));
        var beat = await _ops.AcquireTileLockAsync(id, "t1", CancellationToken.None);
        Assert.True(beat.Succeeded);
        Assert.True(beat.Value!.ExpiresAtUtc > first.Value.ExpiresAtUtc);

        // Another editor gets 409 with the holder named (null directory echoes the id).
        ActAs(Grantee);
        var contested = await _ops.AcquireTileLockAsync(id, "t1", CancellationToken.None);
        Assert.Equal("rcd.dashboard.tile_locked", contested.Error!.Code);
        Assert.Contains(Owner, contested.Error.Message);

        // Release by the holder frees it for the next editor; release is idempotent.
        ActAs(Owner);
        Assert.True((await _ops.ReleaseTileLockAsync(id, "t1", CancellationToken.None)).Succeeded);
        Assert.True((await _ops.ReleaseTileLockAsync(id, "t1", CancellationToken.None)).Succeeded);

        ActAs(Grantee);
        var afterRelease = await _ops.AcquireTileLockAsync(id, "t1", CancellationToken.None);
        Assert.True(afterRelease.Succeeded, afterRelease.Error?.Message);
    }

    [Fact]
    public async Task LockRequiresEditAccess()
    {
        var id = await CreateOwnedDashboardAsync();
        await ShareWithAsync(id, Grantee); // view-only share: zero flags

        ActAs(Grantee);
        var viewOnly = await _ops.AcquireTileLockAsync(id, "t1", CancellationToken.None);
        Assert.Equal("rcd.dashboard.forbidden", viewOnly.Error!.Code);

        ActAs(Bystander);
        var invisible = await _ops.AcquireTileLockAsync(id, "t1", CancellationToken.None);
        Assert.Equal("rcd.dashboard.not_found", invisible.Error!.Code);
    }

    // --------------------------- replays and no-op ops ---------------------------

    [Fact]
    public async Task ReplayedRemove_IsIdempotent_NoBumpNoBroadcast()
    {
        var id = await CreateOwnedDashboardAsync();

        var first = await ApplyAsync(id, "tile", "t2", """{"kind":"tileRemove"}""");
        Assert.True(first.Succeeded, first.Error?.Message);
        Assert.Equal("removal", first.Value!.Class);
        var stampAfterFirst = StoredStamp(id);
        Assert.Single(_notifier.Ops);

        var replay = await ApplyAsync(id, "tile", "t2", """{"kind":"tileRemove"}""");
        Assert.True(replay.Succeeded, replay.Error?.Message);
        Assert.Equal("none", replay.Value!.Class);
        Assert.Equal(stampAfterFirst, replay.Value.UpdatedAtUtc); // baseline still advances correctly
        Assert.Equal(stampAfterFirst, StoredStamp(id));           // nothing persisted
        Assert.Single(_notifier.Ops);                             // nothing broadcast

        // Exactly one "saved" activity row: the replay wrote none.
        Assert.Single(
            _harness.Db.DashboardActivity.Where(a => a.DashboardId == id && a.Action == "saved"));
    }

    [Fact]
    public async Task StaleBaseStamp_DoesNotRejectAnOp()
    {
        // Ops are per-element last-writer-wins: the base stamp is telemetry,
        // never a gate (whole-doc saves keep the strict stamp instead).
        var id = await CreateOwnedDashboardAsync();

        var result = await _ops.ApplyAsync(
            id,
            new DashboardOpSubmission(
                "op-1", "tile", "t1",
                """{"kind":"tileGeometry","layout":{"x":6,"y":0,"w":4,"h":3}}""",
                BaseUpdatedAtUtc: new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc)),
            CancellationToken.None);

        Assert.True(result.Succeeded, result.Error?.Message);
    }

    // ------------------------------ broadcast + audit ------------------------------

    [Fact]
    public async Task CommittedOp_IsBroadcastVerbatim_WithResultStamp()
    {
        var id = await CreateOwnedDashboardAsync();
        const string payload = """{"kind":"tileGeometry","layout":{"x":6,"y":0,"w":4,"h":3}}""";

        var result = await ApplyAsync(id, "tile", "t1", payload, opId: "op-abc");
        Assert.True(result.Succeeded, result.Error?.Message);

        var broadcast = Assert.Single(_notifier.Ops);
        Assert.Equal(id, broadcast.DashboardId);
        Assert.Equal("op-abc", broadcast.OpId);
        Assert.Equal(Owner, broadcast.ActorUserId);
        Assert.Equal("geometry", broadcast.Class);
        Assert.Equal("tile", broadcast.TargetKind);
        Assert.Equal("t1", broadcast.TargetId);
        Assert.Equal(payload, broadcast.PayloadJson);
        Assert.Equal(StoredStamp(id), broadcast.ResultUpdatedAtUtc);
    }

    [Fact]
    public async Task CommittedOp_WritesSavedActivity_LikeTheSavePath()
    {
        var id = await CreateOwnedDashboardAsync();

        var result = await ApplyAsync(id, "tile", "t1",
            """{"kind":"tileGeometry","layout":{"x":6,"y":0,"w":4,"h":3}}""");
        Assert.True(result.Succeeded);

        var saved = _harness.Db.DashboardActivity.Single(a => a.DashboardId == id && a.Action == "saved");
        Assert.Equal(Owner, saved.UserId);
        Assert.Contains("\"geometryChanged\":true", saved.DetailJson);
        Assert.Contains("\"chartsChanged\":false", saved.DetailJson);
    }

    // --------------------------------- validation ---------------------------------

    [Theory]
    [InlineData("tile", "t1", """{"kind":"hologramFlip"}""")]                        // unknown kind
    [InlineData("doc", null, """{"kind":"tileGeometry","layout":{"x":1}}""")]        // kind/targetKind mismatch
    [InlineData("tile", null, """{"kind":"tileRemove"}""")]                          // missing required targetId
    [InlineData("doc", "x1", """{"kind":"docSettingSet","key":"a","value":1}""")]    // targetId on a doc-scoped kind
    [InlineData("tile", "t1", """{"kind":"tileUpsert","tile":{"id":"OTHER"}}""")]    // payload id mismatch
    [InlineData("tile", "t1", """{"kind":"tileGeometry","layout":"not-an-object"}""")]
    [InlineData("doc", null, """{"kind":"docSettingSet","key":"pages","value":[]}""")]   // structural key
    [InlineData("doc", null, """{"kind":"docSettingSet","key":"tiles","value":[]}""")]   // structural key
    [InlineData("doc", null, """{"kind":"pageReorder","pageIds":["p1",42]}""")]      // non-string page id
    [InlineData("doc", "f1", """{"kind":"docElementUpsert","field":"widgets","element":{"id":"f1"}}""")] // unknown field
    [InlineData("tile", "t1", """not json at all""")]
    [InlineData("tile", "t1", """[1,2,3]""")]
    [InlineData("page", "p1", """{"kind":"pageSet","patch":"not-an-object"}""")]            // patch not an object
    [InlineData("page", "p1", """{"kind":"pageSet","patch":{"name":"Sneaky"}}""")]          // patch key outside the two allowed
    [InlineData("page", "p1", """{"kind":"pageSet","patch":{"tiles":[]}}""")]               // patch must never carry structure
    [InlineData("tile", "t1", """{"kind":"tileRemove","junk":1}""")]                        // STRICT: unknown extra field
    [InlineData("page", "p1", """{"kind":"pageRename","name":"Ok","color":"#fff"}""")]      // STRICT: field from another kind
    [InlineData("tile", "t1", """{"kind":"tileGeometry","layout":{"x":1},"pageid":"p1"}""")] // STRICT: typo'd field is loud
    public async Task MalformedOps_AreRejectedAsInvalid(string targetKind, string? targetId, string payload)
    {
        var id = await CreateOwnedDashboardAsync();

        var result = await ApplyAsync(id, targetKind, targetId, payload);

        Assert.False(result.Succeeded);
        Assert.Equal("rcd.dashboard.op_invalid", result.Error!.Code);
        Assert.Equal(ServiceErrorKind.BadRequest, result.Error.Kind);
        Assert.Empty(_notifier.Ops);
    }

    [Theory]
    [InlineData("tile", "t9", """{"kind":"tileGeometry","layout":{"x":1,"y":0,"w":1,"h":1}}""")] // tile vanished
    [InlineData("page", "p9", """{"kind":"pageRename","name":"Ghost"}""")]                        // page vanished
    [InlineData("page", "p9", """{"kind":"pageSet","patch":{"mobileLayout":null}}""")]            // pageSet page vanished
    [InlineData("tile", "t9", """{"kind":"tileUpsert","pageId":"p9","tile":{"id":"t9","kind":"text"}}""")] // page for add vanished
    public async Task OpsOnVanishedTargets_ConflictAsTargetMissing(string targetKind, string targetId, string payload)
    {
        var id = await CreateOwnedDashboardAsync();

        var result = await ApplyAsync(id, targetKind, targetId, payload);

        Assert.False(result.Succeeded);
        Assert.Equal("rcd.dashboard.op_target_missing", result.Error!.Code);
        Assert.Equal(ServiceErrorKind.Conflict, result.Error.Kind);
    }

    [Fact]
    public async Task OpGrowingTheDocPastTheLayoutCap_IsRejected()
    {
        var id = await CreateOwnedDashboardAsync("""{"pages":[{"id":"p1","name":"Main","tiles":[]}]}""");
        _harness.Options.Limits.MaxDashboardLayoutBytes = 120;

        var payload = """{"kind":"tileUpsert","pageId":"p1","tile":{"id":"t1","kind":"text","text":{"html":"__BIG__"}}}"""
            .Replace("__BIG__", new string('x', 200));
        var result = await ApplyAsync(id, "tile", "t1", payload);

        Assert.False(result.Succeeded);
        Assert.Equal("rcd.limit.layout_size", result.Error!.Code);
    }

    [Fact]
    public async Task PageReorder_SurvivesConcurrentlyAddedPages()
    {
        var id = await CreateOwnedDashboardAsync();

        // The reorder only knows p1/p2; p3 arrives first (a collaborator's add).
        var added = await ApplyAsync(id, "page", "p3",
            """{"kind":"pageAdd","page":{"id":"p3","name":"Costs","tiles":[]},"index":0}""");
        Assert.True(added.Succeeded, added.Error?.Message);

        var reordered = await ApplyAsync(id, "doc", null,
            """{"kind":"pageReorder","pageIds":["p2","p1"]}""");
        Assert.True(reordered.Succeeded, reordered.Error?.Message);

        // Listed pages take the listed order; the unknown page keeps its place at the end.
        using var doc = System.Text.Json.JsonDocument.Parse(StoredLayout(id));
        var ids = doc.RootElement.GetProperty("pages").EnumerateArray()
            .Select(p => p.GetProperty("id").GetString())
            .ToArray();
        Assert.Equal(["p2", "p1", "p3"], ids);
    }

    // --------------------------------- test doubles ---------------------------------

    private sealed class RecordingOpNotifier : IRcdDashboardOpNotifier
    {
        public List<RcdDashboardOp> Ops { get; } = [];

        public Task OpAppliedAsync(RcdDashboardOp op, CancellationToken ct)
        {
            Ops.Add(op);
            return Task.CompletedTask;
        }
    }

    private sealed class MutableTimeProvider(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset _now = start;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan by) => _now += by;
    }
}
