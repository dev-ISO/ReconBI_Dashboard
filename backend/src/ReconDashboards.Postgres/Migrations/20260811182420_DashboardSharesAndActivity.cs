using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace ReconDashboards.Postgres.Migrations
{
    /// <inheritdoc />
    public partial class DashboardSharesAndActivity : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "rcd_dashboard_activity",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    DashboardId = table.Column<int>(type: "integer", nullable: false),
                    UserId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Action = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    DetailJson = table.Column<string>(type: "jsonb", nullable: true),
                    AtUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_rcd_dashboard_activity", x => x.Id);
                    table.ForeignKey(
                        name: "FK_rcd_dashboard_activity_rcd_dashboards_DashboardId",
                        column: x => x.DashboardId,
                        principalTable: "rcd_dashboards",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "rcd_dashboard_shares",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    DashboardId = table.Column<int>(type: "integer", nullable: false),
                    UserId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    CanEditLayout = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    CanManagePages = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    CanEditCharts = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    GrantedByUserId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_rcd_dashboard_shares", x => x.Id);
                    table.ForeignKey(
                        name: "FK_rcd_dashboard_shares_rcd_dashboards_DashboardId",
                        column: x => x.DashboardId,
                        principalTable: "rcd_dashboards",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_rcd_dashboard_activity_DashboardId_AtUtc",
                table: "rcd_dashboard_activity",
                columns: new[] { "DashboardId", "AtUtc" },
                descending: new[] { false, true });

            migrationBuilder.CreateIndex(
                name: "IX_rcd_dashboard_shares_DashboardId_UserId",
                table: "rcd_dashboard_shares",
                columns: new[] { "DashboardId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_rcd_dashboard_shares_UserId",
                table: "rcd_dashboard_shares",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "rcd_dashboard_activity");

            migrationBuilder.DropTable(
                name: "rcd_dashboard_shares");
        }
    }
}
