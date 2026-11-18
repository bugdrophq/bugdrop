interface MaskBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface MaskRect extends MaskBounds {
  clip?: MaskBounds;
}

type RedactionReason = 'developer-marked' | 'sensitive-input';
type RedactionStrategy = 'canvas-mask';
type UnsupportedSurfaceReason = 'embedded-document' | 'pixel-content' | 'media-content';

interface RedactionTarget {
  element: Element;
  rect: MaskRect;
  reason: RedactionReason;
  strategy: RedactionStrategy;
}

interface UnsupportedRedactionSurface {
  tagName: string;
  reason: UnsupportedSurfaceReason;
  rect: MaskRect;
}

export interface RedactionSnapshot {
  targets: RedactionTarget[];
  unsupportedSurfaces: UnsupportedRedactionSurface[];
  redactionCount: number;
}

export interface RedactionSummary {
  count: number;
  hasLimitations: boolean;
}

export class MaskApplicationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MaskApplicationError';
  }
}

const EXPLICIT_SELECTOR =
  '[data-bugdrop-mask], [data-bugdrop-redact], [data-bd-redact], [data-bugdrop-redacted]';
const DEFAULT_SELECTOR =
  'input[type="password"], input[autocomplete*="cc-number"], input[autocomplete*="cc-csc"], input[autocomplete*="cc-exp"]';
const UNSUPPORTED_SURFACE_SELECTOR = 'iframe, canvas, img, svg, video';
const PIXEL_CONTENT_TAGS = new Set(['CANVAS', 'IMG', 'SVG']);
const MEDIA_CONTENT_TAGS = new Set(['VIDEO']);

function getRedactionReason(el: Element): RedactionReason | null {
  if (el.matches(EXPLICIT_SELECTOR)) return 'developer-marked';
  if (el.matches(DEFAULT_SELECTOR)) return 'sensitive-input';
  return null;
}

function createTarget(el: Element, reason: RedactionReason): RedactionTarget | null {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    element: el,
    rect: {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      w: rect.width,
      h: rect.height,
    },
    reason,
    strategy: 'canvas-mask',
  };
}

export function createRedactionSnapshot(root: Element): RedactionSnapshot {
  const targets: RedactionTarget[] = [];
  const unsupportedSurfaces: UnsupportedRedactionSurface[] = [];
  if (isBugDropOwnedNode(root)) {
    return { targets, unsupportedSurfaces, redactionCount: 0 };
  }
  const rootReason = getRedactionReason(root);

  if (rootReason) {
    const rootTarget = createTarget(root, rootReason);
    if (rootTarget) {
      targets.push(rootTarget);
      collectUnsupportedSurfaces(root, unsupportedSurfaces);
    }
    return {
      targets,
      unsupportedSurfaces,
      redactionCount: targets.length,
    };
  }

  walk(root, targets, unsupportedSurfaces);
  walkOpenShadowRoot(root, targets, unsupportedSurfaces);
  return {
    targets,
    unsupportedSurfaces,
    redactionCount: targets.length,
  };
}

export function createRedactionPlan(root: Element): RedactionSnapshot {
  return createRedactionSnapshot(root);
}

export function collectMaskRects(root: Element): MaskRect[] {
  return createRedactionSnapshot(root).targets.map(target => target.rect);
}

export function countMaskRects(root: Element = document.body, area?: DOMRect): number {
  const rects = createRedactionSnapshot(root).targets.map(target => target.rect);
  if (!area) return rects.length;
  return rects.filter(rect => intersects(rect, area)).length;
}

export function summarizeRedactionSnapshot(
  snapshot: RedactionSnapshot,
  area?: DOMRect
): RedactionSummary {
  const targets = area
    ? snapshot.targets.filter(target => intersects(target.rect, area))
    : snapshot.targets;
  const unsupportedSurfaces = area
    ? snapshot.unsupportedSurfaces.filter(surface => intersects(surface.rect, area))
    : snapshot.unsupportedSurfaces;

  return {
    count: targets.length,
    hasLimitations: unsupportedSurfaces.length > 0,
  };
}

function intersects(rect: MaskRect, area: DOMRect): boolean {
  return (
    rect.x < area.x + area.width &&
    rect.x + rect.w > area.x &&
    rect.y < area.y + area.height &&
    rect.y + rect.h > area.y
  );
}

function walk(
  node: Element,
  targets: RedactionTarget[],
  unsupportedSurfaces: UnsupportedRedactionSurface[]
): void {
  for (const child of Array.from(node.children)) {
    if (isBugDropOwnedNode(child)) continue;
    const reason = getRedactionReason(child);
    if (reason) {
      const target = createTarget(child, reason);
      if (target) {
        targets.push(target);
        collectUnsupportedSurfaces(child, unsupportedSurfaces);
      }
      // Top-most-ancestor rule: do not descend into masked subtrees.
      continue;
    }
    walk(child, targets, unsupportedSurfaces);
    walkOpenShadowRoot(child, targets, unsupportedSurfaces);
  }
}

function walkOpenShadowRoot(
  node: Element,
  targets: RedactionTarget[],
  unsupportedSurfaces: UnsupportedRedactionSurface[]
): void {
  const shadowRoot = node.shadowRoot;
  if (!shadowRoot) return;

  for (const child of Array.from(shadowRoot.children)) {
    const reason = getRedactionReason(child);
    if (reason) {
      const target = createTarget(child, reason);
      if (target) {
        targets.push(target);
        collectUnsupportedSurfaces(child, unsupportedSurfaces);
      }
      continue;
    }
    walk(child, targets, unsupportedSurfaces);
    walkOpenShadowRoot(child, targets, unsupportedSurfaces);
  }
}

function collectUnsupportedSurfaces(root: Element, surfaces: UnsupportedRedactionSurface[]): void {
  collectUnsupportedSurface(root, surfaces);
  for (const child of Array.from(root.querySelectorAll(UNSUPPORTED_SURFACE_SELECTOR))) {
    collectUnsupportedSurface(child, surfaces);
  }
  walkOpenShadowUnsupportedSurfaces(root, surfaces);
}

function collectUnsupportedSurface(
  element: Element,
  surfaces: UnsupportedRedactionSurface[]
): void {
  const reason = getUnsupportedSurfaceReason(element);
  if (!reason) return;

  const target = createTarget(element, getRedactionReason(element) ?? 'developer-marked');
  if (!target) return;

  surfaces.push({
    tagName: element.tagName,
    reason,
    rect: target.rect,
  });
}

function getUnsupportedSurfaceReason(element: Element): UnsupportedSurfaceReason | null {
  const tagName = element.tagName.toUpperCase();
  if (tagName === 'IFRAME') return 'embedded-document';
  if (PIXEL_CONTENT_TAGS.has(tagName)) return 'pixel-content';
  if (MEDIA_CONTENT_TAGS.has(tagName)) return 'media-content';
  return null;
}

function walkOpenShadowUnsupportedSurfaces(
  root: Element,
  surfaces: UnsupportedRedactionSurface[]
): void {
  const shadowRoot = root.shadowRoot;
  if (shadowRoot) {
    for (const child of Array.from(shadowRoot.querySelectorAll(UNSUPPORTED_SURFACE_SELECTOR))) {
      collectUnsupportedSurface(child, surfaces);
    }
  }

  for (const child of Array.from(root.children)) {
    walkOpenShadowUnsupportedSurfaces(child, surfaces);
  }
}

export function translateMaskRect(
  rect: MaskRect,
  pixelRatio: number,
  originOffset: { x: number; y: number },
  canvasWidth: number,
  canvasHeight: number
): MaskRect {
  const rawX = (rect.x - originOffset.x) * pixelRatio;
  const rawY = (rect.y - originOffset.y) * pixelRatio;
  const rawW = rect.w * pixelRatio;
  const rawH = rect.h * pixelRatio;

  let x = Math.max(0, Math.floor(rawX) - 1);
  let y = Math.max(0, Math.floor(rawY) - 1);
  let right = Math.min(canvasWidth, Math.ceil(rawX + rawW) + 1);
  let bottom = Math.min(canvasHeight, Math.ceil(rawY + rawH) + 1);
  if (rect.clip) {
    const { x: cx, y: cy, w, h } = rect.clip;
    x = Math.max(x, Math.floor((cx - originOffset.x) * pixelRatio));
    y = Math.max(y, Math.floor((cy - originOffset.y) * pixelRatio));
    right = Math.min(right, Math.ceil((cx + w - originOffset.x) * pixelRatio));
    bottom = Math.min(bottom, Math.ceil((cy + h - originOffset.y) * pixelRatio));
  }

  return {
    x,
    y,
    w: right - x,
    h: bottom - y,
  };
}

export async function applyMaskToImage(
  dataUrl: string,
  rects: MaskRect[],
  pixelRatio: number,
  originOffset: { x: number; y: number } = { x: 0, y: 0 }
): Promise<string> {
  if (rects.length === 0) return dataUrl;

  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new MaskApplicationError('Failed to get canvas context for privacy masking');

  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = '#000';
  for (const rect of rects) {
    const t = translateMaskRect(rect, pixelRatio, originOffset, canvas.width, canvas.height);
    if (!(t.w > 0 && t.h > 0)) continue;
    ctx.fillRect(t.x, t.y, t.w, t.h);
  }

  return canvas.toDataURL('image/png');
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new MaskApplicationError('Failed to load image for privacy masking'));
    img.src = dataUrl;
  });
}
import { isBugDropOwnedNode } from './owned-roots';
