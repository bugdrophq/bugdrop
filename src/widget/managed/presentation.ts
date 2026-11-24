import { sanitizeCssColor } from '../sanitize';
import type { BugDropPresentation } from './presentation-types';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parsePresentation(request: string): BugDropPresentation | null {
  if (request.length > 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(request);
  } catch {
    return null;
  }
  if (
    !record(parsed) ||
    Object.keys(parsed).length !== 2 ||
    parsed.version !== 1 ||
    !record(parsed.options) ||
    Object.keys(parsed.options).some(key => key !== 'accentColor')
  )
    return null;

  const color = parsed.options.accentColor;
  if (color === undefined) return {};
  if (typeof color !== 'string') return null;
  const accentColor = sanitizeCssColor(color);
  return accentColor && CSS.supports('color', accentColor) ? { accentColor } : null;
}
