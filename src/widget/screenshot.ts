import * as htmlToImage from 'html-to-image';
import type { Options as HtmlToImageOptions } from 'html-to-image/lib/types';
import { withCaptureTimeout } from './capture-timeout';
import {
  applyMaskToImage,
  countMaskRects,
  createRedactionSnapshot,
  summarizeRedactionSnapshot,
  type RedactionSnapshot,
  type RedactionSummary,
} from './mask';
import { resolveAccentColor } from '../defaults';
import { isBugDropOwnedNode } from './owned-roots';
import { renderArea } from './area-capture-scroll';
export { cropScreenshot } from './crop-screenshot';
export { beginViewportCapture } from './viewport-capture';

declare const __BUGDROP_ENABLE_TEST_HOOKS__: boolean;

const DOM_COMPLEXITY_THRESHOLD = 3_000;
const TRANSPARENT_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
export const FULL_PAGE_DISABLE_THRESHOLD = 10_000;
export const SAFARI_FULL_PAGE_DISABLE_THRESHOLD = DOM_COMPLEXITY_THRESHOLD;

export interface CaptureScreenshotOptions {
  highlightElement?: Element;
  highlightStyle?: {
    accentColor?: string;
    radius?: string;
    borderWidth?: string;
  };
  pixelRatio?: number;
}

export interface CapturedScreenshot {
  dataUrl: string;
  redaction: RedactionSummary;
}

declare global {
  interface Window {
    __bugdropMockToPng?: typeof htmlToImage.toPng;
  }
}

export function getDomNodeCount(): number {
  return document.body.querySelectorAll('*').length;
}

export function isFullPageDisabled(): boolean {
  return getDomNodeCount() >= getFullPageDisableThreshold();
}

export function getFullPageDisableThreshold(userAgent = navigator.userAgent): number {
  return isSafariBrowser(userAgent)
    ? SAFARI_FULL_PAGE_DISABLE_THRESHOLD
    : FULL_PAGE_DISABLE_THRESHOLD;
}

export function isSafariBrowser(userAgent = navigator.userAgent): boolean {
  return (
    /Safari\//.test(userAgent) &&
    !/(Chrome|Chromium|CriOS|FxiOS|Edg|EdgiOS|OPR|Opera)\//.test(userAgent)
  );
}

export function getPixelRatio(isFullPage: boolean, screenshotScale?: number): number {
  if (isFullPage && getDomNodeCount() > DOM_COMPLEXITY_THRESHOLD) {
    return 1;
  }
  const minScale = screenshotScale ?? 2;
  return Math.max(window.devicePixelRatio || 1, minScale);
}

export function canCaptureViewportNatively(): boolean {
  const isSecureOrigin =
    window.isSecureContext ||
    location.protocol === 'https:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';
  const hasCaptureApi =
    typeof window.__bugdropMockViewportCapture === 'function' ||
    typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  return isSecureOrigin && hasCaptureApi;
}

export async function captureScreenshot(
  element?: Element,
  screenshotScale?: number,
  captureOptions: CaptureScreenshotOptions = {}
): Promise<CapturedScreenshot> {
  const target = element || document.body;
  const isFullPage = !element;
  const targetRect = element ? getDocumentRect(element) : getDocumentRect(document.body);
  const highlightRect =
    captureOptions.highlightElement && target.contains(captureOptions.highlightElement)
      ? getDocumentRect(captureOptions.highlightElement)
      : null;

  const pixelRatio = captureOptions.pixelRatio ?? getPixelRatio(isFullPage, screenshotScale);
  const elementStyle = element ? window.getComputedStyle(element) : null;

  const toPng = getToPng();
  const opts: HtmlToImageOptions = {
    cacheBust: false,
    imagePlaceholder: TRANSPARENT_IMAGE_PLACEHOLDER,
    pixelRatio,
    filter: shouldIncludeCaptureNode,
    // Root margins position an element in its parent, but html-to-image copies them inside its
    // border-box crop. Preserve computed vertical margins; clear horizontal margins to stop drift.
    ...(elementStyle && (elementStyle.marginLeft !== '0px' || elementStyle.marginRight !== '0px')
      ? { style: { margin: `${elementStyle.marginTop} 0px ${elementStyle.marginBottom} 0px` } }
      : {}),
  };

  const redactionSnapshot = createRedactionSnapshot(target);
  const originOffset = element ? { x: targetRect.x, y: targetRect.y } : { x: 0, y: 0 };

  const capturePromise = toPng(target as HTMLElement, opts);
  const dataUrl = await withCaptureTimeout(capturePromise);
  const maskedDataUrl = await applyMaskToImage(
    dataUrl,
    redactionSnapshot.targets.map(target => target.rect),
    pixelRatio,
    originOffset
  );

  if (!highlightRect) {
    return capturedScreenshot(maskedDataUrl, redactionSnapshot);
  }

  return capturedScreenshot(
    await applyHighlightToImage(
      maskedDataUrl,
      highlightRect,
      targetRect,
      captureOptions.highlightStyle
    ),
    redactionSnapshot
  );
}

export async function captureAreaScreenshot(
  rect: DOMRect,
  screenshotScale?: number,
  captureOptions: CaptureScreenshotOptions = {}
): Promise<CapturedScreenshot> {
  const pixelRatio = captureOptions.pixelRatio ?? getPixelRatio(true, screenshotScale);
  const targetRect = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  const highlightRect =
    captureOptions.highlightElement && document.body.contains(captureOptions.highlightElement)
      ? getDocumentRect(captureOptions.highlightElement)
      : null;
  const toPng = getToPng();
  const opts: HtmlToImageOptions = {
    cacheBust: false,
    imagePlaceholder: TRANSPARENT_IMAGE_PLACEHOLDER,
    pixelRatio,
    width: rect.width,
    height: rect.height,
    style: {
      transform: `translate(${-rect.x}px, ${-rect.y}px)`,
      transformOrigin: 'top left',
      width: `${document.documentElement.scrollWidth}px`,
      height: `${document.documentElement.scrollHeight}px`,
    },
    filter: shouldIncludeCaptureNode,
  };

  const { dataUrl, redactionSnapshot } = await renderArea(document.body, targetRect, opts, toPng);
  const maskedDataUrl = await applyMaskToImage(
    dataUrl,
    redactionSnapshot.targets.map(target => target.rect),
    pixelRatio,
    {
      x: rect.x,
      y: rect.y,
    }
  );

  if (!highlightRect) {
    return capturedScreenshot(maskedDataUrl, redactionSnapshot, rect);
  }

  return capturedScreenshot(
    await applyHighlightToImage(
      maskedDataUrl,
      highlightRect,
      targetRect,
      captureOptions.highlightStyle
    ),
    redactionSnapshot,
    rect
  );
}

export function getRedactionCount(element?: Element, rect?: DOMRect): number {
  return countMaskRects(element ?? document.body, rect);
}

function shouldIncludeCaptureNode(node: HTMLElement): boolean {
  if (isBugDropOwnedNode(node)) return false;

  return node.tagName?.toUpperCase() !== 'IMG' || !isInvisibleOrZeroSize(node);
}

function isInvisibleOrZeroSize(element: HTMLElement): boolean {
  const style = (element.ownerDocument.defaultView ?? window).getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return true;

  const rect = element.getBoundingClientRect();
  return rect.width <= 0 || rect.height <= 0;
}

function getToPng(): typeof htmlToImage.toPng {
  if (
    (typeof __BUGDROP_ENABLE_TEST_HOOKS__ === 'undefined' || __BUGDROP_ENABLE_TEST_HOOKS__) &&
    window.__bugdropMockToPng
  ) {
    return window.__bugdropMockToPng;
  }
  return htmlToImage.toPng;
}

function capturedScreenshot(
  dataUrl: string,
  snapshot: RedactionSnapshot,
  area?: DOMRect
): CapturedScreenshot {
  return {
    dataUrl,
    redaction: summarizeRedactionSnapshot(snapshot, area),
  };
}

async function applyHighlightToImage(
  dataUrl: string,
  rect: { x: number; y: number; w: number; h: number },
  targetRect: { x: number; y: number; w: number; h: number },
  style: CaptureScreenshotOptions['highlightStyle'] = {}
): Promise<string> {
  if (rect.w <= 0 || rect.h <= 0) return dataUrl;

  const img = await loadImage(dataUrl);
  const imageWidth = img.naturalWidth || img.width;
  const imageHeight = img.naturalHeight || img.height;
  const scaleX = imageWidth / Math.max(1, targetRect.w);
  const scaleY = imageHeight / Math.max(1, targetRect.h);
  const averageScale = Math.max(1, (scaleX + scaleY) / 2);
  const borderWidth = getHighlightBorderWidth(style.borderWidth, averageScale);
  const innerGap = 2 * averageScale;
  const padding = innerGap + borderWidth / 2;
  const rawX = (rect.x - targetRect.x) * scaleX - padding;
  const rawY = (rect.y - targetRect.y) * scaleY - padding;
  const rawW = rect.w * scaleX + padding * 2;
  const rawH = rect.h * scaleY + padding * 2;
  const overflowLeft = Math.max(0, Math.ceil(-rawX));
  const overflowTop = Math.max(0, Math.ceil(-rawY));
  const overflowRight = Math.max(0, Math.ceil(rawX + rawW - imageWidth));
  const overflowBottom = Math.max(0, Math.ceil(rawY + rawH - imageHeight));

  const canvas = document.createElement('canvas');
  canvas.width = imageWidth + overflowLeft + overflowRight;
  canvas.height = imageHeight + overflowTop + overflowBottom;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas context for selected element highlight');
  }

  ctx.drawImage(img, overflowLeft, overflowTop);

  const x = Math.round(rawX + overflowLeft);
  const y = Math.round(rawY + overflowTop);
  const w = Math.round(rawW);
  const h = Math.round(rawH);
  const radius = getHighlightRadius(style.radius, averageScale);
  const accent = resolveAccentColor(style.accentColor);

  drawRoundedRect(ctx, x, y, w, h, radius);
  ctx.lineWidth = borderWidth;
  ctx.strokeStyle = accent;
  ctx.stroke();

  return canvas.toDataURL('image/png');
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function getHighlightBorderWidth(borderWidth: string | undefined, pixelRatio: number): number {
  const parsed = Number.parseFloat(borderWidth || '3');
  return Math.max(1, Math.round((Number.isFinite(parsed) ? parsed : 3) * pixelRatio));
}

function getHighlightRadius(radius: string | undefined, pixelRatio: number): number {
  const parsed = Number.parseFloat(radius || '6');
  return Math.max(0, Math.round((Number.isFinite(parsed) ? parsed : 6) * pixelRatio));
}

function getDocumentRect(element: Element): { x: number; y: number; w: number; h: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    w: rect.width,
    h: rect.height,
  };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for selected element highlight'));
    img.src = dataUrl;
  });
}
