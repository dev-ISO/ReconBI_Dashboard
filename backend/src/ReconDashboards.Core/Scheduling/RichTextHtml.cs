using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace ReconDashboards.Core.Scheduling;

/// <summary>
/// Server-side twin of the GUI's rich-text sanitizer (util/richText.ts) for the
/// two places authored HTML reaches an email: container.innerTitleHtml (kept as
/// markup — the body already is HTML) and xAxisLabelHtml/yAxisLabelHtml (flattened
/// to plain text, because a chart PNG can only draw a string).
///
/// The allowlist is DELIBERATELY narrower than the GUI's: anchors are unwrapped
/// to their text. A subscription email goes to other people's inboxes, and an
/// author-controlled clickable link there is a phishing surface the caption does
/// not need. Everything else follows richText.ts: allowlisted tags only, a
/// filtered style attribute on the text tags, script/style subtrees dropped whole,
/// unknown wrappers unwrapped to their children, and the output always balanced.
/// </summary>
public static class RichTextHtml
{
    private static readonly HashSet<string> AllowedTags = new(StringComparer.Ordinal)
    {
        "p", "br", "b", "strong", "i", "em", "u", "s", "h1", "h2", "h3", "ul", "ol", "li", "span",
    };

    /// <summary>Tags allowed to carry a (filtered) style attribute.</summary>
    private static readonly HashSet<string> StyleTags = new(StringComparer.Ordinal)
    {
        "span", "p", "h1", "h2", "h3", "ul", "ol", "li",
    };

    private static readonly HashSet<string> VoidTags = new(StringComparer.Ordinal) { "br" };

    private static readonly HashSet<string> AllowedStyleProperties = new(StringComparer.Ordinal)
    {
        "color", "font-size", "text-align", "font-weight", "font-style", "text-decoration",
    };

    /// <summary>Active-content elements dropped WITH their children.</summary>
    private static readonly HashSet<string> DropWithChildren = new(StringComparer.Ordinal)
    {
        "script", "style", "noscript", "template", "iframe", "frame", "frameset", "object", "embed",
        "applet", "link", "meta", "base", "title", "head", "svg", "math", "form", "input", "textarea",
        "select", "option", "button", "video", "audio", "source", "track", "canvas", "img", "picture",
        "map", "area", "dialog",
    };

    /// <summary>`&lt;tag attrs&gt;` / `&lt;/tag&gt;` — anything else that starts with '&lt;' is literal text.</summary>
    private static readonly Regex TagPattern = new(
        @"\G<\s*(/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*?)?)/?\s*>", RegexOptions.Compiled);

    private static readonly Regex AttributePattern = new(
        """([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", RegexOptions.Compiled);

    private static readonly Regex CommentPattern = new(
        "<!--.*?-->", RegexOptions.Compiled | RegexOptions.Singleline);

    private static readonly Regex SafeStyleValue = new(
        @"^[a-z0-9#%.,()\s-]+$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex ForbiddenStyleValue = new(
        @"url\s*\(|expression\s*\(|var\s*\(|image-set\s*\(|javascript",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex Whitespace = new(@"\s+", RegexOptions.Compiled);

    /// <summary>
    /// Authored HTML reduced to the allowlisted subset. Empty string for
    /// null/blank input, so callers can test the result rather than the input.
    /// </summary>
    public static string Sanitize(string? html)
    {
        if (string.IsNullOrWhiteSpace(html))
        {
            return "";
        }

        var source = CommentPattern.Replace(html, "");
        var output = new StringBuilder();
        var open = new List<string>();
        var i = 0;
        while (i < source.Length)
        {
            var next = source.IndexOf('<', i);
            if (next < 0)
            {
                output.Append(source[i..]);
                break;
            }

            output.Append(source[i..next]);
            var match = TagPattern.Match(source, next);
            if (!match.Success)
            {
                // A bare '<' in prose: escape it rather than inventing a tag.
                output.Append("&lt;");
                i = next + 1;
                continue;
            }

            i = match.Index + match.Length;
            var closing = match.Groups[1].Value.Length > 0;
            var tag = match.Groups[2].Value.ToLowerInvariant();

            if (DropWithChildren.Contains(tag))
            {
                if (!closing)
                {
                    i = SkipSubtree(source, i, tag);
                }

                continue;
            }

            if (!AllowedTags.Contains(tag))
            {
                continue; // unknown wrapper: unwrapped, children kept
            }

            if (VoidTags.Contains(tag))
            {
                if (!closing)
                {
                    output.Append("<").Append(tag).Append('>');
                }

                continue;
            }

            if (closing)
            {
                var at = open.LastIndexOf(tag);
                if (at < 0)
                {
                    continue; // stray close: dropped, never emitted unbalanced
                }

                for (var d = open.Count - 1; d >= at; d--)
                {
                    output.Append("</").Append(open[d]).Append('>');
                }

                open.RemoveRange(at, open.Count - at);
                continue;
            }

            output.Append('<').Append(tag);
            if (StyleTags.Contains(tag) && SafeStyle(match.Groups[3].Value) is { Length: > 0 } style)
            {
                output.Append(" style=\"").Append(style).Append('"');
            }

            output.Append('>');
            open.Add(tag);
        }

        for (var d = open.Count - 1; d >= 0; d--)
        {
            output.Append("</").Append(open[d]).Append('>');
        }

        return output.ToString();
    }

    /// <summary>
    /// Authored HTML flattened to one line of text (tags stripped, entities
    /// decoded, whitespace collapsed). Null when nothing readable remains — the
    /// axis-title callers fall back to their plain label then.
    /// </summary>
    public static string? ToPlainText(string? html)
    {
        if (string.IsNullOrWhiteSpace(html))
        {
            return null;
        }

        var source = CommentPattern.Replace(html, "");
        var text = new StringBuilder();
        var i = 0;
        while (i < source.Length)
        {
            var next = source.IndexOf('<', i);
            if (next < 0)
            {
                text.Append(source[i..]);
                break;
            }

            text.Append(source[i..next]);
            var match = TagPattern.Match(source, next);
            if (!match.Success)
            {
                text.Append('<');
                i = next + 1;
                continue;
            }

            i = match.Index + match.Length;
            var tag = match.Groups[2].Value.ToLowerInvariant();
            if (DropWithChildren.Contains(tag) && match.Groups[1].Value.Length == 0)
            {
                i = SkipSubtree(source, i, tag);
                continue;
            }

            // Block boundaries are word boundaries once the markup is gone.
            text.Append(' ');
        }

        var flattened = Whitespace.Replace(WebUtility.HtmlDecode(text.ToString()), " ").Trim();
        return flattened.Length > 0 ? flattened : null;
    }

    /// <summary>
    /// Elements whose CONTENT is raw text, so an unterminated one really does
    /// swallow the rest of the input. Every other dropped element (img, input,
    /// link…) may legitimately have no closing tag — treating those as open
    /// would silently eat the caption that follows.
    /// </summary>
    private static readonly HashSet<string> RawTextTags = new(StringComparer.Ordinal)
    {
        "script", "style", "noscript", "template", "title", "textarea",
    };

    /// <summary>Index just past the matching close tag; the tag alone when there is none.</summary>
    private static int SkipSubtree(string source, int from, string tag)
    {
        var close = source.IndexOf("</" + tag, from, StringComparison.OrdinalIgnoreCase);
        if (close < 0)
        {
            return RawTextTags.Contains(tag) ? source.Length : from;
        }

        var end = source.IndexOf('>', close);
        return end < 0 ? source.Length : end + 1;
    }

    /// <summary>The allowlisted style declarations of an attribute run, re-serialized.</summary>
    private static string SafeStyle(string attributes)
    {
        var kept = new List<string>();
        foreach (Match attribute in AttributePattern.Matches(attributes))
        {
            if (!string.Equals(attribute.Groups[1].Value, "style", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var raw = attribute.Groups[2].Success ? attribute.Groups[2].Value
                : attribute.Groups[3].Success ? attribute.Groups[3].Value
                : attribute.Groups[4].Value;
            foreach (var declaration in WebUtility.HtmlDecode(raw).Split(';'))
            {
                var colon = declaration.IndexOf(':');
                if (colon <= 0)
                {
                    continue;
                }

                var property = declaration[..colon].Trim().ToLowerInvariant();
                var value = declaration[(colon + 1)..].Trim();
                if (AllowedStyleProperties.Contains(property)
                    && value.Length > 0
                    && SafeStyleValue.IsMatch(value)
                    && !ForbiddenStyleValue.IsMatch(value))
                {
                    kept.Add(property + ":" + value);
                }
            }
        }

        return string.Join(";", kept);
    }
}
