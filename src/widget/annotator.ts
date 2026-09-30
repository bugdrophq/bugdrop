export type Tool = 'draw' | 'arrow' | 'rect' | 'redact';

interface Point {
  x: number;
  y: number;
}

const ANNOTATION_COLOR = '#ff0000';
const REDACTION_COLOR = '#000000';
const VISIBLE_ANNOTATION_LINE_WIDTH = 5.5;
const ARROW_HEAD_ANGLE = Math.PI / 7;
const MIN_ANNOTATION_DISTANCE = 2;
const MIN_REDACTION_SIZE = 4;
const REDACTION_PADDING = 1;

export function createAnnotator(
  container: HTMLElement,
  imageData: string
): {
  setTool: (tool: Tool) => void;
  undo: () => void;
  getImageData: () => string;
  destroy: () => void;
} {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  let currentTool: Tool = 'draw';
  let isDrawing = false;
  let points: Point[] = [];
  let draftBase: ImageData | null = null;
  let hasDrawnStroke = false;
  let activePointerId: number | null = null;
  const history: ImageData[] = [];

  // Load image
  const img = new Image();
  img.onload = () => {
    // Keep full resolution in canvas, scale display via CSS
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.style.maxWidth = '100%';
    canvas.style.height = 'auto';
    canvas.style.cursor = 'crosshair';

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
    isDrawing = false;
    points = [];
    draftBase = null;
    hasDrawnStroke = false;
  }

  function cancelDraft() {
    if (draftBase) restoreState(draftBase);
    resetDraft();
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

  function drawLine(from: Point, to: Point) {
    const lineWidth = getLineWidth();

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = ANNOTATION_COLOR;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function drawArrow(from: Point, to: Point) {
    // Line
    drawLine(from, to);

    // Arrowhead
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const headLength = getLineWidth() * 5;

    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(
      to.x - headLength * Math.cos(angle - ARROW_HEAD_ANGLE),
      to.y - headLength * Math.sin(angle - ARROW_HEAD_ANGLE)
    );
    ctx.lineTo(
      to.x - headLength * Math.cos(angle + ARROW_HEAD_ANGLE),
      to.y - headLength * Math.sin(angle + ARROW_HEAD_ANGLE)
    );
    ctx.closePath();
    ctx.fillStyle = ANNOTATION_COLOR;
    ctx.fill();
  }

  function drawRect(from: Point, to: Point) {
    ctx.strokeStyle = ANNOTATION_COLOR;
    ctx.lineWidth = getLineWidth();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y);
  }

  function getRectBounds(from: Point, to: Point) {
    const x = Math.min(from.x, to.x);
    const y = Math.min(from.y, to.y);
    const width = Math.abs(to.x - from.x);
    const height = Math.abs(to.y - from.y);
    return { x, y, width, height };
  }

  function getRedactionBounds(from: Point, to: Point) {
    const { x, y, width, height } = getRectBounds(from, to);
    const left = Math.max(0, Math.floor(x) - REDACTION_PADDING);
    const top = Math.max(0, Math.floor(y) - REDACTION_PADDING);
    const right = Math.min(canvas.width, Math.ceil(x + width) + REDACTION_PADDING);
    const bottom = Math.min(canvas.height, Math.ceil(y + height) + REDACTION_PADDING);
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function isMeaningfulRedaction(from: Point, to: Point) {
    const { width, height } = getRedactionBounds(from, to);
    return width >= MIN_REDACTION_SIZE && height >= MIN_REDACTION_SIZE;
  }

  function drawRedaction(from: Point, to: Point) {
    const { x, y, width, height } = getRedactionBounds(from, to);
    ctx.fillStyle = REDACTION_COLOR;
    ctx.fillRect(x, y, width, height);
  }

  function handlePointerDown(e: PointerEvent) {
    if (activePointerId !== null || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) {
      return;
    }
    const base = getLatestState();
    if (!base) return;

    e.preventDefault();
    activePointerId = e.pointerId;
    isDrawing = true;
    points = [getCanvasPoint(e)];
    draftBase = base;
    hasDrawnStroke = false;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
  }

  function handlePointerMove(e: PointerEvent) {
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
    if (e.pointerId === activePointerId) cancelDraft();
  }

  // Event handlers
  canvas.addEventListener('pointerdown', handlePointerDown);

  return {
    setTool(tool: Tool) {
      cancelDraft();
      currentTool = tool;
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
      resetDraft();
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.remove();
    },
  };
}
