import { describe, it, expect } from 'vitest';

/**
 * Tests for the widget's apiUrl derivation from script src.
 *
 * The widget computes its API base URL by replacing the widget filename
 * in the script's src attribute. This must work for all versioned paths:
 *   /widget.js, /widget.v1.js, /widget.v1.1.js, /widget.v1.1.0.js
 *
 * Regression: a literal .replace('/widget.js', '/api') silently failed
 * for versioned paths, causing malformed API URLs like
 * /widget.v1.js/check/owner/repo instead of /api/check/owner/repo.
 */

import { resolveWidgetApiUrl } from '../src/widget/api-url';

function deriveApiUrl(src: string): string {
  return resolveWidgetApiUrl({ src, dataset: {} });
}

describe('Widget apiUrl derivation', () => {
  const base = 'https://bugdrop.neonwatty.workers.dev';

  it('handles /widget.js (unversioned)', () => {
    expect(deriveApiUrl(`${base}/widget.js`)).toBe(`${base}/api`);
  });

  it('handles /widget.v1.js (major version)', () => {
    expect(deriveApiUrl(`${base}/widget.v1.js`)).toBe(`${base}/api`);
  });

  it('handles /widget.v1.1.js (minor version)', () => {
    expect(deriveApiUrl(`${base}/widget.v1.1.js`)).toBe(`${base}/api`);
  });

  it('handles /widget.v1.1.0.js (patch version)', () => {
    expect(deriveApiUrl(`${base}/widget.v1.1.0.js`)).toBe(`${base}/api`);
  });

  it('handles double-digit versions', () => {
    expect(deriveApiUrl(`${base}/widget.v12.34.56.js`)).toBe(`${base}/api`);
  });

  it('returns original URL if pattern does not match', () => {
    const url = `${base}/other-script.js`;
    expect(deriveApiUrl(url)).toBe(url);
  });
  it('routes a pinned self-hosted asset to its explicit backend', () => {
    expect(
      resolveWidgetApiUrl({
        src: 'https://app.example/vendor/digest/widget.v1.js',
        dataset: { apiUrl: 'https://feedback.example/api' },
      })
    ).toBe('https://feedback.example/api');
  });

  it('keeps script-host routing when the override is empty or absent', () => {
    expect(resolveWidgetApiUrl({ src: `${base}/widget.v1.js`, dataset: { apiUrl: '' } })).toBe(
      `${base}/api`
    );
    expect(resolveWidgetApiUrl(null)).toBe('');
  });
});
