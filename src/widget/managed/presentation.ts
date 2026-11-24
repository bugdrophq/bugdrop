import { sanitizeCssColor } from '../sanitize';
import type { BugDropPresentation } from './presentation-types';

export interface ManagedAccent {
  background: string;
  foreground: '#000' | '#fff';
}

interface ManagedPresentation {
  accent?: ManagedAccent;
}

const accentColorKey: keyof BugDropPresentation = 'accentColor';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parsePresentation(
  request: string,
  parent: HTMLElement
): ManagedPresentation | null {
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
    Object.keys(parsed.options).some(key => key !== accentColorKey)
  )
    return null;

  const color = parsed.options[accentColorKey];
  if (color === undefined) return {};
  if (typeof color !== 'string') return null;
  const accent = resolveAccent(color, parent);
  return accent ? { accent } : null;
}

function resolveAccent(color: string, parent: HTMLElement): ManagedAccent | null {
  const safe = sanitizeCssColor(color);
  if (
    !safe ||
    /^(?:inherit|initial|unset|revert|revert-layer)$/i.test(safe) ||
    !CSS.supports('color', safe)
  )
    return null;

  // Evaluate host design tokens before the widget acknowledges the configuration.
  const probe = document.createElement('span');
  probe.hidden = true;
  probe.style.setProperty('--bugdrop-accent-probe', safe);
  parent.append(probe);
  let background: string;
  try {
    background = getComputedStyle(probe).getPropertyValue('--bugdrop-accent-probe').trim();
  } finally {
    probe.remove();
  }
  if (!background || /^currentcolor$/i.test(background)) return null;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) return null;

  // Canvas retains its previous fill when a color is invalid. Two starting
  // colors distinguish that case from a legitimate color matching either one.
  context.fillStyle = '#000';
  context.fillStyle = background;
  const fill = context.fillStyle;
  context.fillStyle = '#fff';
  context.fillStyle = background;
  if (fill !== context.fillStyle) return null;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha !== 255) return null;
  const luminance = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  return { background, foreground: luminance > 0.179 ? '#000' : '#fff' };
}

function linear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
