using System.Text.Json;
using System.Text.Json.Serialization;

namespace ReconDashboards.Core.Modeling;

/// <summary>
/// (De)serialization for persisted model definitions. Strict on purpose: unknown
/// fields are rejected so a v2 document fails loudly on a v1 engine instead of
/// silently dropping settings.
/// </summary>
public static class ModelJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 16,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static string Serialize(ModelDefinition definition) =>
        JsonSerializer.Serialize(definition, Options);

    /// <summary>
    /// Parses and version-gates a definition document. Returns null with an
    /// error message instead of throwing so callers map failures to 422s.
    /// </summary>
    public static ModelDefinition? TryDeserialize(string json, out string? error)
    {
        ModelDefinition? definition;
        try
        {
            definition = JsonSerializer.Deserialize<ModelDefinition>(json, Options);
        }
        catch (JsonException ex)
        {
            error = $"Invalid model definition JSON: {ex.Message}";
            return null;
        }

        if (definition is null)
        {
            error = "Model definition is empty.";
            return null;
        }

        if (definition.Version != ModelDefinition.CurrentVersion)
        {
            error = $"Unsupported model definition version {definition.Version}; this engine supports version {ModelDefinition.CurrentVersion}.";
            return null;
        }

        error = null;
        return definition with
        {
            Tables = definition.Tables ?? [],
            Relationships = definition.Relationships ?? [],
            Measures = definition.Measures ?? [],
        };
    }
}
