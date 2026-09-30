export interface Point {
  x: number;
  y: number;
}

const ANNOTATION_COLOR = '#ff0000';
const REDACTION_COLOR = '#000000';
const ARROW_HEAD_ANGLE = Math.PI / 7;
const MIN_REDACTION_SIZE = 4;
const REDACTION_PADDING = 1;

export function createAnnotationMarks(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  getLineWidth: () => number
) {
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
    drawLine(from, to);
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

  function getRedactionBounds(from: Point, to: Point) {
    const x = Math.min(from.x, to.x);
    const y = Math.min(from.y, to.y);
    const width = Math.abs(to.x - from.x);
    const height = Math.abs(to.y - from.y);
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

  return { drawLine, drawArrow, drawRect, drawRedaction, isMeaningfulRedaction };
}
