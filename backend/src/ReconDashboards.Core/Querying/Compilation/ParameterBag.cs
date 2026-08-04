using ReconDashboards.Core.Schema;

namespace ReconDashboards.Core.Querying.Compilation;

/// <summary>
/// One bound query parameter. Values are CLR objects already converted to the
/// referenced column's type; IsArray marks set parameters (IN lists) that
/// providers bind as a single array (PostgreSQL) or expand (other engines).
/// </summary>
public sealed record QueryParameter(string Name, object? Value, NormalizedType Type, bool IsArray = false);

/// <summary>Accumulates parameters during compilation; names are p0, p1, ...</summary>
public sealed class ParameterBag
{
    private readonly List<QueryParameter> _parameters = [];

    public IReadOnlyList<QueryParameter> Parameters => _parameters;

    public string Add(object? value, NormalizedType type)
    {
        var name = $"p{_parameters.Count}";
        _parameters.Add(new QueryParameter(name, value, type));
        return name;
    }

    public string AddArray(IReadOnlyList<object?> values, NormalizedType elementType)
    {
        var name = $"p{_parameters.Count}";
        _parameters.Add(new QueryParameter(name, values, elementType, IsArray: true));
        return name;
    }
}
