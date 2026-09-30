import { createAnnotationMarks, type Point } from './annotation-marks';

export type Tool = 'draw' | 'arrow' | 'rect' | 'redact' | 'pan';

const VISIBLE_ANNOTATION_LINE_WIDTH = 5.5;
const MIN_ANNOTATION_DISTANCE = 2;
const ZOOM_LEVELS = [0.75, 1, 1.5, 2, 3, 4];

export function createAnnotator(
  container: HTMLElement,
  imageData: string
): {
  setTool: (tool: Tool) => void;
  fitWidth: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
  getZoom: () => number;
  undo: () => void;
  getImageData: () => string;
  destroy: () => void;
} {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const { drawLine, drawArrow, drawRect, drawRedaction, isMeaningfulRedaction } =
    createAnnotationMarks(ctx, canvas, getLineWidth);

  let currentTool: Tool = 'draw';
  let isDrawing = false;
  let points: Point[] = [];
  let draftBase: ImageData | null = null;
  let hasDrawnStroke = false;
  let activePointerId: number | null = null;
  let panOrigin: { x: number; y: number; left: number; top: number } | null = null;
  let zoom = 1;
  const history: ImageData[] = [];

  // Load image
  const img = new Image();
  img.onload = () => {
    // Keep full resolution in canvas, scale display via CSS
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.style.width = `min(${zoom * 100}%, ${img.width * zoom}px)`;
    ctx.drawImage(img, 0, 0);

    // Commit the unannotated screenshot as the undo floor.
    commitState();
  };
  img.src = imageData;

  container.appendChild(canvas);

  function commitState() {
    history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }

  function restoreState(state: ImageData) {
    ctx.putImageData(state, 0, 0);
  }

  function getLatestState() {
    return history[history.length - 1] ?? null;
  }

  function getDistance(from: Point, to: Point) {
    return Math.hypot(to.x - from.x, to.y - from.y);
  }

  function resetDraft() {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerCancel);
    activePointerId = null;
    panOrigin = null;
    isDrawing = false;
    points = [];
    draftBase = null;
    hasDrawnStroke = false;
  }

  function cancelDraft() {
    if (draftBase) restoreState(draftBase);
    resetDraft();
    canvas.style.cursor = currentTool === 'pan' ? 'grab' : 'crosshair';
  }

  function getCanvasPoint(e: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect();
    const scaleX = img.width / rect.width;
    const scaleY = img.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    return {
      x: Math.max(0, Math.min(canvas.width, x)),
      y: Math.max(0, Math.min(canvas.height, y)),
    };
  }

  function getLineWidth() {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.max(canvas.width / rect.width, canvas.height / rect.height, 1);
    return Math.round(VISIBLE_ANNOTATION_LINE_WIDTH * scale);
  }

  function handlePointerDown(e: PointerEvent) {
    if (activePointerId !== null || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) {
      return;
    }
    const base = getLatestState();
    if (!base) return;

    e.preventDefault();
    activePointerId = e.pointerId;
    if (currentTool === 'pan') {
      panOrigin = {
        x: e.clientX,
        y: e.clientY,
        left: container.scrollLeft,
        top: container.scrollTop,
      };
      canvas.style.cursor = 'grabbing';
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerCancel);
      return;
    }
    isDrawing = true;
    points = [getCanvasPoint(e)];
    draftBase = base;
    hasDrawnStroke = false;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
  }

  function handlePointerMove(e: PointerEvent) {
    if (panOrigin && e.pointerId === activePointerId) {
      e.preventDefault();
      container.scrollLeft = panOrigin.left + panOrigin.x - e.clientX;
      container.scrollTop = panOrigin.top + panOrigin.y - e.clientY;
      return;
    }
    if (!isDrawing || !draftBase || e.pointerId !== activePointerId) return;
    e.preventDefault();

    const point = getCanvasPoint(e);

    if (currentTool === 'draw') {
      drawLine(points[points.length - 1], point);
      points.push(point);
      hasDrawnStroke = hasDrawnStroke || getDistance(points[0], point) >= MIN_ANNOTATION_DISTANCE;
    } else {
      // Preview for shape-like tools.
      restoreState(draftBase);

      if (currentTool === 'arrow') {
        drawArrow(points[0], point);
      } else if (currentTool === 'rect') {
        drawRect(points[0], point);
      } else if (currentTool === 'redact') {
        drawRedaction(points[0], point);
      }
    }
  }

  function handlePointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    e.preventDefault();
    if (panOrigin) {
      resetDraft();
      canvas.style.cursor = 'grab';
      return;
    }
    if (!isDrawing || !draftBase) {
      resetDraft();
      return;
    }

    const point = getCanvasPoint(e);
    const start = points[0];
    const isMeaningfulAnnotation =
      currentTool === 'redact'
        ? isMeaningfulRedaction(start, point)
        : hasDrawnStroke || getDistance(start, point) >= MIN_ANNOTATION_DISTANCE;

    if (!isMeaningfulAnnotation) {
      restoreState(draftBase);
      resetDraft();
      return;
    }

    if (currentTool === 'arrow') {
      restoreState(draftBase);
      drawArrow(start, point);
    } else if (currentTool === 'rect') {
      restoreState(draftBase);
      drawRect(start, point);
    } else if (currentTool === 'redact') {
      restoreState(draftBase);
      drawRedaction(start, point);
    } else if (currentTool === 'draw' && !hasDrawnStroke) {
      drawLine(start, point);
    }

    commitState();
    resetDraft();
  }

  function handlePointerCancel(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    if (panOrigin) {
      container.scrollLeft = panOrigin.left;
      container.scrollTop = panOrigin.top;
      resetDraft();
      canvas.style.cursor = 'grab';
    } else {
      cancelDraft();
    }
  }

  function setZoom(nextZoom: number) {
    cancelDraft();
    const centerX = container.scrollLeft + container.clientWidth / 2;
    const centerY = container.scrollTop + container.clientHeight / 2;
    const ratio = nextZoom / zoom;
    zoom = nextZoom;
    canvas.style.width = `min(${zoom * 100}%, ${img.width * zoom}px)`;
    container.scrollLeft = centerX * ratio - container.clientWidth / 2;
    container.scrollTop = centerY * ratio - container.clientHeight / 2;
  }

  // Event handlers
  canvas.addEventListener('pointerdown', handlePointerDown);

  return {
    setTool(tool: Tool) {
      cancelDraft();
      currentTool = tool;
      canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
    },

    fitWidth() {
      setZoom(1);
    },

    zoomIn() {
      setZoom(ZOOM_LEVELS.find(level => level > zoom) ?? zoom);
    },

    zoomOut() {
      setZoom([...ZOOM_LEVELS].reverse().find(level => level < zoom) ?? zoom);
    },

    resetView() {
      setZoom(1);
      container.scrollLeft = 0;
      container.scrollTop = 0;
    },

    getZoom() {
      return zoom;
    },

    undo() {
      if (draftBase) {
        cancelDraft();
        return;
      }

      if (history.length <= 1) return;

      resetDraft();
      history.pop();
      const previousState = getLatestState();
      if (previousState) restoreState(previousState);
    },

    getImageData(): string {
      return canvas.toDataURL('image/png');
    },

    destroy() {
      cancelDraft();
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.remove();
    },
  };
}
