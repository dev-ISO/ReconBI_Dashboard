using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ReconDashboards.Postgres.Migrations
{
    /// <inheritdoc />
    public partial class ShareMoveAndDeleteRights : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "CanDeleteContent",
                table: "rcd_dashboard_shares",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "CanMoveTiles",
                table: "rcd_dashboard_shares",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            // Backfill so PRE-EXISTING grantees keep exactly the abilities they
            // had before the rights were split out (no silent regression):
            //  - moving/resizing tiles used to ride the layout class
            //    -> CanMoveTiles := CanEditLayout;
            //  - removing chart tiles rode the charts class and removing pages
            //    rode the pages class -> CanDeleteContent := CanEditCharts OR
            //    CanManagePages. (A layout-only grantee loses static-tile
            //    removal — the locked 0.11.1 decision: deletion is an explicit
            //    right, and layout-only was never meant to include destroying
            //    content.)
            migrationBuilder.Sql(
                """
                UPDATE rcd_dashboard_shares
                SET "CanMoveTiles" = "CanEditLayout",
                    "CanDeleteContent" = ("CanEditCharts" OR "CanManagePages");
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "CanDeleteContent",
                table: "rcd_dashboard_shares");

            migrationBuilder.DropColumn(
                name: "CanMoveTiles",
                table: "rcd_dashboard_shares");
        }
    }
}
