using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ReconDashboards.Postgres.Migrations
{
    /// <inheritdoc />
    public partial class SubscriptionEmailContent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Per-subscription email content config (EMAIL-CONTENT-DESIGN).
            // Deliberately NULLABLE with NO backfill: NULL means the legacy
            // behavior these rows already have (tables, 50-row cap), so nothing
            // about an existing subscription's email changes on upgrade. Rows
            // gain an explicit config the next time they are saved.
            migrationBuilder.AddColumn<string>(
                name: "ContentJson",
                table: "rcd_subscriptions",
                type: "jsonb",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ContentJson",
                table: "rcd_subscriptions");
        }
    }
}
