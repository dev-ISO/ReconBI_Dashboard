using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace ReconDashboards.Postgres.Migrations
{
    /// <inheritdoc />
    public partial class SubscriptionDispatchesAndOptOuts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "rcd_global_optouts",
                columns: table => new
                {
                    Email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    OptedOutUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_rcd_global_optouts", x => x.Email);
                });

            migrationBuilder.CreateTable(
                name: "rcd_subscription_dispatches",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    SubscriptionId = table.Column<int>(type: "integer", nullable: false),
                    SubscriptionName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    OwnerUserId = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    DashboardId = table.Column<int>(type: "integer", nullable: false),
                    Trigger = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    RequestedBy = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    StartedUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: false),
                    FinishedUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: true),
                    Status = table.Column<string>(type: "character varying(12)", maxLength: 12, nullable: false),
                    Error = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_rcd_subscription_dispatches", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "rcd_subscription_optouts",
                columns: table => new
                {
                    SubscriptionId = table.Column<int>(type: "integer", nullable: false),
                    Email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    OptedOutUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_rcd_subscription_optouts", x => new { x.SubscriptionId, x.Email });
                });

            migrationBuilder.CreateTable(
                name: "rcd_subscription_dispatch_recipients",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    DispatchId = table.Column<long>(type: "bigint", nullable: false),
                    Email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    Status = table.Column<string>(type: "character varying(12)", maxLength: 12, nullable: false),
                    Attempts = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    Error = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    SentUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: true),
                    OpenedUtc = table.Column<DateTime>(type: "timestamp without time zone", nullable: true),
                    OpenCount = table.Column<int>(type: "integer", nullable: false, defaultValue: 0)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_rcd_subscription_dispatch_recipients", x => x.Id);
                    table.ForeignKey(
                        name: "FK_rcd_subscription_dispatch_recipients_rcd_subscription_dispa~",
                        column: x => x.DispatchId,
                        principalTable: "rcd_subscription_dispatches",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_rcd_subscription_dispatch_recipients_DispatchId",
                table: "rcd_subscription_dispatch_recipients",
                column: "DispatchId");

            migrationBuilder.CreateIndex(
                name: "IX_rcd_subscription_dispatches_Status_StartedUtc",
                table: "rcd_subscription_dispatches",
                columns: new[] { "Status", "StartedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_rcd_subscription_dispatches_SubscriptionId_StartedUtc",
                table: "rcd_subscription_dispatches",
                columns: new[] { "SubscriptionId", "StartedUtc" },
                descending: new[] { false, true });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "rcd_global_optouts");

            migrationBuilder.DropTable(
                name: "rcd_subscription_dispatch_recipients");

            migrationBuilder.DropTable(
                name: "rcd_subscription_optouts");

            migrationBuilder.DropTable(
                name: "rcd_subscription_dispatches");
        }
    }
}
