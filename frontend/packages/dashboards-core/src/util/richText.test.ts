import { describe, expect, it } from 'vitest';
import { boldRunText, retitleInnerTitleHtml } from './richText';

/* Inputs mirror the seeded-dashboard inner-title pattern (rich HTML that
 * already passed sanitizeRichHtml): a bold lead-in carrying the visible name,
 * followed by a muted description span. The helper must rewrite ONLY the bold
 * text and must run without a DOM (this suite runs in plain node). */

const SEED_HTML =
  '<p><b>Valve Status</b> <span style="color:#64748b">&mdash; open vs closed by area</span></p>';

describe('retitleInnerTitleHtml', () => {
  it('rewrites the text of the first <b> element, preserving everything else', () => {
    expect(retitleInnerTitleHtml(SEED_HTML, 'Valve Status (copy)')).toBe(
      '<p><b>Valve Status (copy)</b> <span style="color:#64748b">&mdash; open vs closed by area</span></p>',
    );
  });

  it('handles attributes on the bold tag', () => {
    expect(
      retitleInnerTitleHtml('<p><b style="color:#111">Old</b> rest</p>', 'New'),
    ).toBe('<p><b style="color:#111">New</b> rest</p>');
  });

  it('handles <strong> and keeps the tag name', () => {
    expect(retitleInnerTitleHtml('<p><strong>Old</strong> tail</p>', 'New')).toBe(
      '<p><strong>New</strong> tail</p>',
    );
  });

  it('touches only the FIRST bold element', () => {
    expect(
      retitleInnerTitleHtml('<p><b>First</b> and <b>Second</b></p>', 'Renamed'),
    ).toBe('<p><b>Renamed</b> and <b>Second</b></p>');
  });

  it('replaces nested markup inside the bold run with the plain new title', () => {
    expect(retitleInnerTitleHtml('<p><b>Old <i>fancy</i></b> tail</p>', 'New')).toBe(
      '<p><b>New</b> tail</p>',
    );
  });

  it('HTML-escapes the new title', () => {
    expect(retitleInnerTitleHtml('<p><b>Old</b></p>', 'A <5 & B > C')).toBe(
      '<p><b>A &lt;5 &amp; B &gt; C</b></p>',
    );
  });

  it('returns null when there is no bold element (caller keeps the HTML)', () => {
    expect(retitleInnerTitleHtml('<p>Just prose, no bold name</p>', 'New')).toBeNull();
    expect(retitleInnerTitleHtml('', 'New')).toBeNull();
  });

  it('does not mistake other tags starting with b for bold', () => {
    // <br> must not match the <b> pattern.
    expect(retitleInnerTitleHtml('<p>line<br>break</p>', 'New')).toBeNull();
  });
});

/* boldRunText is the READ half of retitleInnerTitleHtml: the auto-retitle
 * paths compare it against the source chart title and rewrite ONLY when the
 * bold lead-in still IS that title — a customized lead-in rides through. It
 * must run without a DOM, like the writer. */

describe('boldRunText', () => {
  it('extracts the first bold run, trimmed', () => {
    expect(boldRunText(SEED_HTML)).toBe('Valve Status');
    expect(boldRunText('<p><b>  Padded  </b> tail</p>')).toBe('Padded');
  });

  it('reads <strong> and only the FIRST bold element', () => {
    expect(boldRunText('<p><strong>First</strong> and <b>Second</b></p>')).toBe('First');
  });

  it('strips nested markup inside the run', () => {
    expect(boldRunText('<p><b>Old <i>fancy</i></b> tail</p>')).toBe('Old fancy');
  });

  it('decodes entities so escaped titles compare equal to their source', () => {
    expect(boldRunText('<p><b>A &lt;5 &amp; B &gt; C</b></p>')).toBe('A <5 & B > C');
    // Numeric references (decimal + hex) and the common named ones.
    expect(boldRunText('<p><b>Caf&#233; &#x2014; Q&ndash;2</b></p>')).toBe('Café — Q–2');
    // Single-pass decode: &amp;lt; is the TEXT "&lt;", never "<".
    expect(boldRunText('<p><b>&amp;lt;tag&amp;gt;</b></p>')).toBe('&lt;tag&gt;');
  });

  it('round-trips what retitleInnerTitleHtml wrote', () => {
    const title = 'New <Title> & Co';
    const rewritten = retitleInnerTitleHtml(SEED_HTML, title);
    expect(rewritten).not.toBeNull();
    expect(boldRunText(rewritten!)).toBe(title);
  });

  it('returns null when there is no bold element', () => {
    expect(boldRunText('<p>Just prose</p>')).toBeNull();
    expect(boldRunText('<p>line<br>break</p>')).toBeNull();
    expect(boldRunText('')).toBeNull();
  });
});
