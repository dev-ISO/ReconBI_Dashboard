import { describe, expect, it } from 'vitest';
import { retitleInnerTitleHtml } from './richText';

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
