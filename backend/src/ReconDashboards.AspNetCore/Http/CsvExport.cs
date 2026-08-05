using System.Globalization;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;
using ReconDashboards.Core.Querying.Execution;
using ReconDashboards.Core.Querying.Spec;

namespace ReconDashboards.AspNetCore.Http;

/// <summary>POST /query/export body. Mode is validated server-side (bad values are a 400).</summary>
public sealed record ExportRequest(ChartQuerySpec Spec, ExportMode? Mode = null, int? MaxRows = null);

/// <summary>
/// Streams an <see cref="ExportOutcome"/> as RFC-4180 CSV. The result writes
/// row by row to the response body — no full-document string is ever built.
/// Truncation is signalled out of band via the X-Rcd-Truncated header so the
/// CSV itself stays clean.
/// </summary>
public sealed class CsvExportResult(ExportOutcome outcome) : IActionResult
{
    public const string TruncatedHeader = "X-Rcd-Truncated";

    public async Task ExecuteResultAsync(ActionContext context)
    {
        var response = context.HttpContext.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = "text/csv; charset=utf-8";

        var disposition = new ContentDispositionHeaderValue("attachment");
        disposition.SetHttpFileName(CsvExport.FileName(outcome.ModelName));
        response.Headers[HeaderNames.ContentDisposition] = disposition.ToString();

        if (outcome.Truncated)
        {
            response.Headers[TruncatedHeader] = "true";
        }

        await CsvExport.WriteAsync(outcome, response.Body, context.HttpContext.RequestAborted);
    }
}

/// <summary>
/// CSV rendering rules: RFC-4180 quoting (quotes doubled; fields containing
/// quote/comma/CR/LF wrapped), CRLF row terminators, ISO dates, invariant
/// numbers, and formula-injection hardening — any TEXT field starting with
/// '=', '+', '-' or '@' is prefixed with a single quote. Numeric fields are
/// never hardened (a negative number is data, not a formula).
/// </summary>
public static class CsvExport
{
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    public static string FileName(string modelName)
    {
        var safe = new string(modelName
            .Where(c => char.IsLetterOrDigit(c) || c is ' ' or '-' or '_' or '.')
            .ToArray()).Trim();
        return (safe.Length == 0 ? "export" : safe) + ".csv";
    }

    public static async Task WriteAsync(ExportOutcome outcome, Stream stream, CancellationToken ct)
    {
        await using var writer = new StreamWriter(stream, Utf8NoBom, bufferSize: 16 * 1024, leaveOpen: true);

        var header = string.Join(",", outcome.Compiled.Columns.Select(c => Escape(Harden(c.Label))));
        await writer.WriteAsync(header);
        await writer.WriteAsync("\r\n");

        var line = new StringBuilder();
        foreach (var row in outcome.Rows)
        {
            ct.ThrowIfCancellationRequested();
            line.Clear();
            for (var i = 0; i < row.Length; i++)
            {
                if (i > 0)
                {
                    line.Append(',');
                }

                line.Append(FormatField(row[i]));
            }

            line.Append("\r\n");
            await writer.WriteAsync(line, ct);
        }

        await writer.FlushAsync(ct);
    }

    /// <summary>One fully rendered (formatted, hardened, escaped) CSV field.</summary>
    public static string FormatField(object? value) => value switch
    {
        null => "",
        string s => Escape(Harden(s)),
        bool b => b ? "true" : "false",
        DateOnly d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DateTime dt => dt.TimeOfDay == TimeSpan.Zero
            ? dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : dt.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture),
        DateTimeOffset dto => dto.ToString("yyyy-MM-ddTHH:mm:ssK", CultureInfo.InvariantCulture),
        TimeOnly t => t.ToString("HH:mm:ss", CultureInfo.InvariantCulture),
        byte[] bytes => Escape(Harden(Convert.ToBase64String(bytes))),
        char c => Escape(Harden(c.ToString())),
        // Numbers, Guid, TimeSpan: invariant text, never hardened (a leading
        // '-' on a number is a sign, not a formula).
        IFormattable f => Escape(f.ToString(null, CultureInfo.InvariantCulture)),
        // Arrays and other composites (e.g. Postgres int[]): joined invariantly.
        System.Collections.IEnumerable items => Escape(Harden(JoinEnumerable(items))),
        _ => Escape(Harden(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "")),
    };

    private static string JoinEnumerable(System.Collections.IEnumerable items) =>
        string.Join(",", items.Cast<object?>().Select(item => item switch
        {
            null => "",
            IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
            _ => item.ToString() ?? "",
        }));

    private static string Harden(string field) =>
        field.Length > 0 && field[0] is '=' or '+' or '-' or '@' ? "'" + field : field;

    private static string Escape(string field) =>
        field.IndexOfAny(['"', ',', '\n', '\r']) >= 0
            ? "\"" + field.Replace("\"", "\"\"") + "\""
            : field;
}
