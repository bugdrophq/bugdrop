import type { Options } from 'html-to-image/lib/types';
import { withCaptureTimeout } from './capture-timeout';
import { createRedactionSnapshot, type RedactionSnapshot } from './mask';
import { isBugDropOwnedNode } from './owned-roots';

type MaskRect = RedactionSnapshot['targets'][number]['rect'];
type Bounds = NonNullable<MaskRect['clip']>;

interface SnapMarker {
  position: 'absolute' | 'relative';
  margin: string;
}

type AreaRenderOptions = Options & {
  onAreaClone?: (source: Element, clone: Element) => void;
};

export async function renderArea(
  root: HTMLElement,
  crop: Bounds,
  options: Options,
  toPng: (root: HTMLElement, options: AreaRenderOptions) => Promise<string>
): Promise<{ dataUrl: string; redactionSnapshot: RedactionSnapshot }> {
  const snapshot = createRedactionSnapshot(root);
  const scroll = prepareAreaScroll(root, crop, snapshot, options.filter);
  const dataUrl = await withCaptureTimeout(
    toPng(root, scroll ? { ...options, onAreaClone: scroll.onAreaClone } : options)
  );
  if (scroll?.pending.size) {
    throw new Error('Area capture could not restore container scroll state');
  }
  return { dataUrl, redactionSnapshot: scroll?.redaction ?? snapshot };
}

function prepareAreaScroll(
  root: HTMLElement,
  crop: Bounds,
  redaction: RedactionSnapshot,
  filter: Options['filter']
) {
  const scrollers = new Map<HTMLElement, Bounds>();
  collectScrollers(root, scrollers);
  if (scrollers.size === 0) return null;

  const restoring = new Set<Element>();
  const pending = new Set<Element>([root]);
  const anchors = new Map<Element, string>();
  const markers = new Map<Element, SnapMarker>();
  for (const [element, clip] of scrollers) {
    // An out-of-crop scrollport needs no anchor. Use its live clip when
    // deciding whether any of its masks belong in the crop.
    if (!intersect(crop, clip)) continue;
    const anchor = findSnapAnchor(element, element, filter);
    if (anchor) {
      anchors.set(anchor, centeredSnapMargin(anchorBounds(anchor, element), element));
      pending.add(anchor);
    } else {
      const marker = createSnapMarker(element);
      if (!marker) continue;
      markers.set(element, marker);
    }
    restoring.add(element);
    pending.add(element);
  }
  const privateNodes = new Set(redaction.targets.map(target => target.element));
  const targets = redaction.targets.flatMap(target => {
    const rect = clipToScrollers(target.rect, target.element, scrollers);
    return rect ? [{ ...target, rect }] : [];
  });

  const onAreaClone: NonNullable<AreaRenderOptions['onAreaClone']> = (source, clone) => {
    if (!isStyled(clone)) return;
    if (source === root) pending.delete(root);
    const { style } = clone;
    const margin = anchors.get(source);
    if (restoring.has(source)) {
      style.setProperty('scroll-snap-type', 'both mandatory', 'important');
      style.setProperty('scroll-padding', '0px', 'important');
      const marker = markers.get(source);
      if (marker) appendSnapMarker(clone, marker);
      pending.delete(source);
    }
    if (margin !== undefined) {
      setSnapTarget(style, margin);
      pending.delete(source);
    } else if (
      style.scrollSnapAlign &&
      style.scrollSnapAlign !== 'none' &&
      usesRestoredScrollport(source, restoring)
    ) {
      // Only replace authored targets in scrollports we are actually restoring.
      style.setProperty('scroll-snap-align', 'none', 'important');
    }
    if (privateNodes.has(source)) {
      // Hide the cloned content before rasterization. The canvas pass still paints
      // the visible mask black, even if the cloned and live layouts differ.
      style.setProperty('opacity', '0', 'important');
    }
  };

  return {
    redaction: { ...redaction, targets, redactionCount: targets.length },
    onAreaClone,
    pending,
  };
}

function collectScrollers(element: Element, scrollers: Map<HTMLElement, Bounds>): void {
  if (isBugDropOwnedNode(element) || element.namespaceURI !== 'http://www.w3.org/1999/xhtml')
    return;
  if (element instanceof HTMLElement && element !== document.scrollingElement) {
    if ((element.scrollLeft || element.scrollTop) && !(element instanceof HTMLTextAreaElement)) {
      const clip = scrollportBounds(element);
      if (clip.w > 0 && clip.h > 0) scrollers.set(element, clip);
    }
  }
  for (const child of composedChildren(element)) collectScrollers(child, scrollers);
}

function scrollportBounds(element: HTMLElement): Bounds {
  const box = element.getBoundingClientRect();
  const bounds = {
    x: box.x + window.scrollX,
    y: box.y + window.scrollY,
    w: box.width,
    h: box.height,
  };
  const hasInsets =
    element.clientLeft ||
    element.clientTop ||
    element.clientWidth !== element.offsetWidth ||
    element.clientHeight !== element.offsetHeight;
  // A rotated or reflected border-box AABB has no reliable side insets.
  // Keep the larger measured bounds so a visible mask is never clipped away.
  if (!hasInsets || !hasAlignedInsets(element)) return bounds;
  const scaleX = element.offsetWidth ? box.width / element.offsetWidth : 1;
  const scaleY = element.offsetHeight ? box.height / element.offsetHeight : 1;
  return {
    x: bounds.x + element.clientLeft * scaleX,
    y: bounds.y + element.clientTop * scaleY,
    w: element.clientWidth * scaleX,
    h: element.clientHeight * scaleY,
  };
}

function hasAlignedInsets(element: Element): boolean {
  for (let node: Element | null = element; node; node = composedParent(node)) {
    const { transform, rotate, scale, perspective } = getComputedStyle(node);
    if ((rotate && rotate !== 'none') || (perspective && perspective !== 'none')) return false;
    if (scale?.split(/\s+/).some(value => parseFloat(value) < 0)) return false;
    if (!transform || transform === 'none') continue;
    const matrix = new DOMMatrixReadOnly(transform);
    if (!matrix.is2D || matrix.b || matrix.c || matrix.a < 0 || matrix.d < 0) return false;
  }
  return true;
}

function composedChildren(element: Element): Element[] {
  return element instanceof HTMLSlotElement
    ? element.assignedElements()
    : Array.from((element.shadowRoot ?? element).children);
}

function composedParent(element: Element): Element | null {
  const parent = element.parentNode;
  return (
    element.assignedSlot ?? (parent instanceof ShadowRoot ? parent.host : element.parentElement)
  );
}

function clippingParent(element: Element): Element | null {
  const { position } = getComputedStyle(element);
  if (position !== 'fixed' && position !== 'absolute') return composedParent(element);
  // Overflow ancestors between an out-of-flow element and its containing
  // block do not clip it. Keep the measured mask if the browser provides
  // no offsetParent API, as with a positioned SVG.
  return element instanceof HTMLElement ? element.offsetParent : null;
}

function usesRestoredScrollport(element: Element, restoring: ReadonlySet<Element>): boolean {
  for (let parent = clippingParent(element); parent; parent = clippingParent(parent)) {
    if (restoring.has(parent)) return true;
    const { display, overflowX, overflowY } = getComputedStyle(parent);
    // Overflow does not create a scroll container on a boxless or inline wrapper.
    if (display === 'contents' || display === 'inline') continue;
    if (/auto|scroll|hidden|overlay/.test(`${overflowX} ${overflowY}`)) return false;
  }
  return false;
}

function clipToScrollers(
  rect: MaskRect,
  element: Element,
  scrollers: ReadonlyMap<Element, Bounds>
): MaskRect | null {
  let clip: Bounds | undefined;
  for (let parent = clippingParent(element); parent; parent = clippingParent(parent)) {
    const scrollport = scrollers.get(parent);
    if (!scrollport) continue;
    clip = clip ? intersect(clip, scrollport) : scrollport;
    if (!clip) return null;
  }
  if (!clip) return rect;
  const visible = intersect(rect, clip);
  return visible ? { ...visible, clip } : null;
}

function intersect(a: Bounds, b: Bounds): Bounds | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

function findSnapAnchor(
  parent: Element,
  scroller: HTMLElement,
  filter: Options['filter']
): HTMLElement | undefined {
  const children = composedChildren(parent);
  for (const child of children) {
    if (
      !(child instanceof HTMLElement) ||
      isBugDropOwnedNode(child) ||
      (filter && !filter(child))
    ) {
      continue;
    }
    const { display, position, transform, translate, rotate, scale, zoom } =
      getComputedStyle(child);
    if (display === 'contents') {
      const anchor = findSnapAnchor(child, scroller, filter);
      if (anchor) return anchor;
      continue;
    }
    if (display === 'inline' || position === 'fixed') continue;
    if ([transform, translate, rotate, scale].some(value => value && value !== 'none')) continue;
    if (zoom && !['1', 'normal', '100%'].includes(zoom)) continue;
    if (position === 'absolute' && clippingParent(child) !== scroller) continue;
    if (position === 'sticky') {
      // An only child filling the scrollable axis has no room to stick.
      const fillsScrollContent =
        parent === scroller &&
        children.length === 1 &&
        (!scroller.scrollTop || child.offsetHeight >= scroller.scrollHeight) &&
        (!scroller.scrollLeft || child.offsetWidth >= scroller.scrollWidth);
      if (!fillsScrollContent) continue;
    }
    if (child.offsetWidth > 0 && child.offsetHeight > 0) return child;
  }
  return undefined;
}

function createSnapMarker(element: HTMLElement): SnapMarker | null {
  const style = getComputedStyle(element);
  const positioned = style.position !== 'static';
  if (!positioned && !['block', 'flow-root', 'inline-block', 'list-item'].includes(style.display)) {
    return null;
  }
  // A zero-size in-flow block also handles a static scroller containing bare text.
  const vertical = style.writingMode !== 'horizontal-tb';
  const fromRight = vertical ? style.writingMode.endsWith('-rl') : style.direction === 'rtl';
  const fromBottom = vertical && style.direction === 'rtl';
  const x = fromRight
    ? element.clientWidth - parseFloat(style.paddingRight)
    : parseFloat(style.paddingLeft);
  const y = fromBottom
    ? element.clientHeight - parseFloat(style.paddingBottom)
    : parseFloat(style.paddingTop);
  return {
    position: positioned ? 'absolute' : 'relative',
    margin: centeredSnapMargin(
      { x: positioned ? 0 : x, y: positioned ? 0 : y, w: 0, h: 0 },
      element
    ),
  };
}

function appendSnapMarker(clone: Element, marker: SnapMarker): void {
  const node = document.createElement('span');
  node.setAttribute(
    'style',
    `all:initial!important;display:block!important;position:${marker.position}!important;
      left:0!important;top:0!important;width:0!important;height:0!important;
      scroll-snap-align:center!important;scroll-margin:${marker.margin}!important`
  );
  clone.prepend(node);
}

function setSnapTarget(style: CSSStyleDeclaration, margin: string): void {
  style.setProperty('scroll-snap-align', 'center', 'important');
  style.setProperty('scroll-margin', margin, 'important');
}

function anchorBounds(anchor: HTMLElement, scroller: HTMLElement): Bounds {
  const point = layoutOrigin(anchor);
  const origin = layoutOrigin(scroller);
  return {
    x: point.x - origin.x - scroller.clientLeft,
    y: point.y - origin.y - scroller.clientTop,
    w: anchor.offsetWidth,
    h: anchor.offsetHeight,
  };
}

function layoutOrigin(element: HTMLElement): { x: number; y: number } {
  const parent = element.offsetParent;
  if (!(parent instanceof HTMLElement)) return { x: element.offsetLeft, y: element.offsetTop };
  const origin = layoutOrigin(parent);
  return {
    x: origin.x + parent.clientLeft + element.offsetLeft,
    y: origin.y + parent.clientTop + element.offsetTop,
  };
}

function centeredSnapMargin(box: Bounds, scroller: HTMLElement): string {
  // Scroll offsets are not serialized to SVG. Express the snap area in
  // layout coordinates so rotation of the scrollport does not change it.
  const centerX = scroller.scrollLeft + scroller.clientWidth / 2;
  const centerY = scroller.scrollTop + scroller.clientHeight / 2;
  return [
    box.y - centerY + 0.5,
    centerX - box.x - box.w + 0.5,
    centerY - box.y - box.h + 0.5,
    box.x - centerX + 0.5,
  ]
    .map(value => `${value}px`)
    .join(' ');
}

function isStyled(node: Node): node is HTMLElement | SVGElement {
  return node instanceof HTMLElement || node instanceof SVGElement;
}
