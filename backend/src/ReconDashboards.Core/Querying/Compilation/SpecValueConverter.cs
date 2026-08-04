using System.Globalization;
using System.Text.Json;
using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Querying.Compilation;

/// <summary>
/// Converts raw JSON filter values to CLR values of the referenced column's
/// type. Strict on purpose: a mismatched value is a clear 400, never a string
/// smuggled into SQL. Converted values are only ever bound as parameters.
/// </summary>
public static class SpecValueConverter
{
    public static object Convert(JsonElement value, NormalizedType targetType, string context)
    {
        try
        {
            return targetType switch
            {
                NormalizedType.Text => value.ValueKind == JsonValueKind.String
                    ? value.GetString()!
                    : throw Mismatch(value, targetType, context),
                NormalizedType.Integer => value.ValueKind == JsonValueKind.Number
                    ? value.GetInt64()
                    : throw Mismatch(value, targetType, context),
                NormalizedType.Decimal => value.ValueKind == JsonValueKind.Number
                    ? value.GetDecimal()
                    : throw Mismatch(value, targetType, context),
                NormalizedType.Boolean => value.ValueKind is JsonValueKind.True or JsonValueKind.False
                    ? value.GetBoolean()
                    : throw Mismatch(value, targetType, context),
                NormalizedType.Date => value.ValueKind == JsonValueKind.String
                    ? DateOnly.Parse(value.GetString()!, CultureInfo.InvariantCulture)
                    : throw Mismatch(value, targetType, context),
                NormalizedType.Timestamp => value.ValueKind == JsonValueKind.String
                    ? DateTime.SpecifyKind(
                        DateTime.Parse(value.GetString()!, CultureInfo.InvariantCulture,
                            DateTimeStyles.AdjustToUniversal),
                        DateTimeKind.Unspecified)
                    : throw Mismatch(value, targetType, context),
                NormalizedType.Uuid => value.ValueKind == JsonValueKind.String
                    ? Guid.Parse(value.GetString()!)
                    : throw Mismatch(value, targetType, context),
                _ => throw new QueryCompilationException(
                    "QRY_BAD_FILTER", $"{context}: columns of type {targetType} cannot be filtered."),
            };
        }
        catch (FormatException)
        {
            throw Mismatch(value, targetType, context);
        }
    }

    private static QueryCompilationException Mismatch(JsonElement value, NormalizedType targetType, string context) =>
        new("QRY_BAD_VALUE",
            $"{context}: value {value.GetRawText()} cannot be interpreted as {targetType}.");
}
