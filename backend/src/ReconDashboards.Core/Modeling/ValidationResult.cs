namespace ReconDashboards.Core.Modeling;

public enum IssueSeverity
{
    Error,
    Warning,
}

/// <summary>
/// One validation finding. <paramref name="Path"/> is a JSON-pointer-ish hint
/// ("relationships[2]", "measures[0].column") the GUI uses for highlighting.
/// </summary>
public sealed record ValidationIssue(string Code, IssueSeverity Severity, string Message, string? Path = null);

public sealed class ValidationResult
{
    private readonly List<ValidationIssue> _issues = [];

    public IReadOnlyList<ValidationIssue> Issues => _issues;

    public IEnumerable<ValidationIssue> Errors => _issues.Where(i => i.Severity == IssueSeverity.Error);

    public IEnumerable<ValidationIssue> Warnings => _issues.Where(i => i.Severity == IssueSeverity.Warning);

    public bool IsValid => _issues.All(i => i.Severity != IssueSeverity.Error);

    public void AddError(string code, string message, string? path = null) =>
        _issues.Add(new ValidationIssue(code, IssueSeverity.Error, message, path));

    public void AddWarning(string code, string message, string? path = null) =>
        _issues.Add(new ValidationIssue(code, IssueSeverity.Warning, message, path));
}
