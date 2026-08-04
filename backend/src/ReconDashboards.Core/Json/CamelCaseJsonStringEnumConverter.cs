using System.Text.Json;
using System.Text.Json.Serialization;

namespace ReconDashboards.Core.Json;

/// <summary>
/// Attribute-applied camelCase string-enum converter. Spec and model enums wear
/// this so the wire format ("sum", "manyToOne", "fk") is identical no matter
/// how a host configured its MVC serializer. Reads are case-insensitive.
/// </summary>
public sealed class CamelCaseJsonStringEnumConverter<TEnum>()
    : JsonStringEnumConverter<TEnum>(JsonNamingPolicy.CamelCase)
    where TEnum : struct, Enum;
