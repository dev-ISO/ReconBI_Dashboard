using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using ReconDashboards.Core.Services;

namespace ReconDashboards.AspNetCore.Controllers;

[ApiController]
public abstract class RcdControllerBase : ControllerBase
{
    /// <summary>
    /// Maps service errors to ProblemDetails with a stable machine-readable
    /// errorCode extension. Validation failures carry the full issue list for
    /// GUI highlighting. Never leaks SQL or database internals.
    /// </summary>
    protected IActionResult FromError(ServiceError error)
    {
        var status = error.Kind switch
        {
            ServiceErrorKind.BadRequest => StatusCodes.Status400BadRequest,
            ServiceErrorKind.NotFound => StatusCodes.Status404NotFound,
            ServiceErrorKind.Forbidden => StatusCodes.Status403Forbidden,
            ServiceErrorKind.Conflict => StatusCodes.Status409Conflict,
            ServiceErrorKind.Validation => StatusCodes.Status422UnprocessableEntity,
            ServiceErrorKind.LimitExceeded => StatusCodes.Status422UnprocessableEntity,
            ServiceErrorKind.TooManyRequests => StatusCodes.Status429TooManyRequests,
            ServiceErrorKind.PreconditionRequired => StatusCodes.Status428PreconditionRequired,
            ServiceErrorKind.Upstream => StatusCodes.Status502BadGateway,
            _ => StatusCodes.Status500InternalServerError,
        };

        var problem = new ProblemDetails
        {
            Title = error.Code,
            Detail = error.Message,
            Status = status,
        };
        problem.Extensions["errorCode"] = error.Code;

        if (error.Validation is not null)
        {
            problem.Extensions["issues"] = error.Validation.Issues
                .Select(issue => new
                {
                    code = issue.Code,
                    severity = issue.Severity.ToString().ToLowerInvariant(),
                    message = issue.Message,
                    path = issue.Path,
                })
                .ToArray();
        }

        return new ObjectResult(problem) { StatusCode = status };
    }

    protected IActionResult Rcd404(string code, string message)
    {
        var problem = new ProblemDetails
        {
            Title = code,
            Detail = message,
            Status = StatusCodes.Status404NotFound,
        };
        problem.Extensions["errorCode"] = code;
        return new ObjectResult(problem) { StatusCode = StatusCodes.Status404NotFound };
    }
}
