using ReconDashboards.Core.Modeling;

namespace ReconDashboards.Core.Services;

public enum ServiceErrorKind
{
    BadRequest,
    NotFound,
    Forbidden,
    Conflict,
    Validation,
    LimitExceeded,

    /// <summary>The caller must wait for an in-flight operation (maps to 429), e.g. a concurrent manual send.</summary>
    TooManyRequests,

    /// <summary>The downstream database failed or was unreachable (maps to 502).</summary>
    Upstream,
}

/// <summary>
/// Service-layer failure with a stable machine code ("rcd.model.not_found") the
/// HTTP layer maps to ProblemDetails. Validation failures carry the full result
/// for GUI highlighting.
/// </summary>
public sealed record ServiceError(
    ServiceErrorKind Kind,
    string Code,
    string Message,
    ValidationResult? Validation = null);

public sealed class ServiceResult<T>
{
    private ServiceResult(T? value, ServiceError? error)
    {
        Value = value;
        Error = error;
    }

    public T? Value { get; }

    public ServiceError? Error { get; }

    public bool Succeeded => Error is null;

    public static ServiceResult<T> Ok(T value) => new(value, null);

    public static ServiceResult<T> Fail(ServiceError error) => new(default, error);

    public static ServiceResult<T> Fail(ServiceErrorKind kind, string code, string message, ValidationResult? validation = null) =>
        new(default, new ServiceError(kind, code, message, validation));
}
