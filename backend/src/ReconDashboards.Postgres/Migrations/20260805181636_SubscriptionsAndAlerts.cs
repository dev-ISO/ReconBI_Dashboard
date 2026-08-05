using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace ReconDashboards.Postgres.Migrations
{
    /// <inheritdoc />
    public partial class SubscriptionsAndAlerts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "rcd_alerts",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    OwnerUserId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    DashboardId = table.Column<int>(type: "integer", nullable: true),
                    Name = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    SpecJson = table.Column<string>(type: "jsonb", nullable: false),
                    Operator = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    Threshold = table.Column<decimal>(type: "numeric(28,8)", precision: 28, scale: 8, nullable: false),
                    Recipients = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    EveryMinutes = table.Column<int>(type: "integer", nullable: false),
                    CooldownMinutes = table.Column<int>(type: "integer", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    LastEvaluatedUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: true),
                    LastFiredUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: true),
                    LastValue = table.Column<decimal>(type: "numeric(28,8)", precision: 28, scale: 8, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_rcd_alerts", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "rcd_subscriptions",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    DashboardId = table.Column<int>(type: "integer", nullable: false),
                    OwnerUserId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Name = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    ScheduleKind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    IntervalMinutes = table.Column<int>(type: "integer", nullable: true),
                    TimeOfDayMinutesUtc = table.Column<int>(type: "integer", nullable: true),
                    DayOfWeekUtc = table.Column<int>(type: "integer", nullable: true),
                    Recipients = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    Format = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    LastRunUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_rcd_subscriptions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_rcd_subscriptions_rcd_dashboards_DashboardId",
                        column: x => x.DashboardId,
                        principalTable: "rcd_dashboards",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_rcd_alerts_DashboardId",
                table: "rcd_alerts",
                column: "DashboardId");

            migrationBuilder.CreateIndex(
                name: "IX_rcd_alerts_Enabled_LastEvaluatedUtc",
                table: "rcd_alerts",
                columns: new[] { "Enabled", "LastEvaluatedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_rcd_alerts_LastFiredUtc",
                table: "rcd_alerts",
                column: "LastFiredUtc");

            migrationBuilder.CreateIndex(
                name: "IX_rcd_alerts_OwnerUserId",
                table: "rcd_alerts",
                column: "OwnerUserId");

            migrationBuilder.CreateIndex(
                name: "IX_rcd_subscriptions_DashboardId",
                table: "rcd_subscriptions",
                column: "DashboardId");

            migrationBuilder.CreateIndex(
                name: "IX_rcd_subscriptions_Enabled_LastRunUtc",
                table: "rcd_subscriptions",
                columns: new[] { "Enabled", "LastRunUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_rcd_subscriptions_OwnerUserId",
                table: "rcd_subscriptions",
                column: "OwnerUserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "rcd_alerts");

            migrationBuilder.DropTable(
                name: "rcd_subscriptions");
        }
    }
}
