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
  try {
    const token = getComputedStyle(probe).getPropertyValue('--bugdrop-accent-probe').trim();
    if (!token || !CSS.supports('color', token)) return null;
    // Resolve contextual colors against the host, then paint and measure the same sRGB value.
    const srgb = `color(from ${token} srgb r g b / alpha)`;
    probe.style.setProperty('color', CSS.supports('color', srgb) ? srgb : token, 'important');
    return accentFromComputedColor(getComputedStyle(probe).color);
  } finally {
    probe.remove();
  }
}

function accentFromComputedColor(color: string): ManagedAccent | null {
  const srgb = /^color\(srgb ([^)]+)\)$/.exec(color);
  const channels = srgb?.[1] ?? /^rgba?\(([^)]+)\)$/.exec(color)?.[1];
  if (!channels) return null;
  const values = channels
    .trim()
    .split(/[\s,/]+/)
    .map(value => (value === 'none' ? 0 : Number(value)));
  if (values.length < 3 || values.length > 4 || !values.every(Number.isFinite)) return null;
  const [r, g, b, alpha = 1] = values;
  if (alpha !== 1) return null;
  const toByte = (value: number) =>
    Math.round(Math.max(0, Math.min(255, value * (srgb ? 255 : 1))));
  const [red, green, blue] = [toByte(r), toByte(g), toByte(b)];
  const luminance = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  return {
    background: `rgb(${red}, ${green}, ${blue})`,
    foreground: luminance > 0.179 ? '#000' : '#fff',
  };
}

function linear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
