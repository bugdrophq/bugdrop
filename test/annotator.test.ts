// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnnotator, type Tool } from '../src/widget/annotator';

interface ContextMock {
  beginPath: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  putImageData: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  strokeRect: ReturnType<typeof vi.fn>;
  fillStyle: string;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  lineWidth: number;
  strokeStyle: string;
}

function pointer(
  type: string,
  x: number,
  y: number,
  pointerType = 'mouse',
  pointerId = 1,
  isPrimary = true
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
    isPrimary: { value: isPrimary },
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
  });
  return event;
}

function drag(canvas: HTMLCanvasElement, from: [number, number], to: [number, number]): void {
  canvas.dispatchEvent(pointer('pointerdown', ...from));
  window.dispatchEvent(pointer('pointermove', ...to));
  window.dispatchEvent(pointer('pointerup', ...to));
}

describe('createAnnotator', () => {
  let OriginalImage: typeof Image;
  let context: ContextMock;
  let snapshotNumber: number;

  beforeEach(() => {
    document.body.innerHTML = '<div id="container"></div>';
    snapshotNumber = 0;
    context = {
      beginPath: vi.fn(),
      closePath: vi.fn(),
      drawImage: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      getImageData: vi.fn(() => ({ marker: ++snapshotNumber }) as unknown as ImageData),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      putImageData: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
      fillStyle: '',
      lineCap: 'butt',
      lineJoin: 'miter',
      lineWidth: 1,
      strokeStyle: '',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,annotated'
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 20,
      width: 200,
      height: 100,
      right: 210,
      bottom: 120,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    });

    OriginalImage = window.Image;
    (window as unknown as { Image: unknown }).Image = class FakeImage {
      onload: (() => void) | null = null;
      width = 400;
      height = 200;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    };
  });

  afterEach(() => {
    (window as unknown as { Image: unknown }).Image = OriginalImage;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  async function setup() {
    const container = document.querySelector<HTMLElement>('#container')!;
    const annotator = createAnnotator(container, 'data:image/png;base64,source');
    await Promise.resolve();
    return { annotator, canvas: container.querySelector('canvas')! };
  }

  it('scales pointer coordinates to canvas pixels and clamps output bounds', async () => {
    const { annotator, canvas } = await setup();
    drag(canvas, [60, 45], [260, 150]);

    expect(context.moveTo).toHaveBeenCalledWith(100, 50);
    expect(context.lineTo).toHaveBeenCalledWith(400, 200);
    expect(context.lineWidth).toBe(11);
    expect(context.strokeStyle).toBe('#ff0000');
    expect(annotator.getImageData()).toBe('data:image/png;base64,annotated');
  });

  it('emits durable canvas output for every annotation tool', async () => {
    const { annotator, canvas } = await setup();
    const useTool = (tool: Tool) => {
      annotator.setTool(tool);
      drag(canvas, [30, 40], [90, 80]);
    };

    useTool('draw');
    useTool('arrow');
    expect(context.fill).toHaveBeenCalled();
    useTool('rect');
    expect(context.strokeRect).toHaveBeenCalledWith(40, 40, 120, 80);
    useTool('redact');
    expect(context.fillRect).toHaveBeenCalledWith(39, 39, 122, 82);
    expect(context.getImageData).toHaveBeenCalledTimes(5);
  });

  it('commits draw, arrow, rectangle, and redaction from touch drags', async () => {
    const { annotator, canvas } = await setup();

    for (const tool of ['draw', 'arrow', 'rect', 'redact'] as const) {
      annotator.setTool(tool);
      canvas.dispatchEvent(pointer('pointerdown', 30, 40, 'touch'));
      window.dispatchEvent(pointer('pointermove', 90, 80, 'touch'));
      window.dispatchEvent(pointer('pointerup', 90, 80, 'touch'));
    }

    expect(context.stroke).toHaveBeenCalled();
    expect(context.fill).toHaveBeenCalled();
    expect(context.strokeRect).toHaveBeenCalledWith(40, 40, 120, 80);
    expect(context.fillRect).toHaveBeenCalledWith(39, 39, 122, 82);
    expect(context.getImageData).toHaveBeenCalledTimes(5);
  });

  it('undoes mixed completed annotations in order', async () => {
    const { annotator, canvas } = await setup();
    drag(canvas, [30, 40], [90, 80]);
    annotator.setTool('arrow');
    drag(canvas, [40, 45], [100, 85]);
    annotator.setTool('rect');
    drag(canvas, [50, 50], [110, 90]);

    context.putImageData.mockClear();
    annotator.undo();
    annotator.undo();
    annotator.undo();
    annotator.undo();

    expect(
      context.putImageData.mock.calls.map(([state]) => (state as { marker: number }).marker)
    ).toEqual([3, 2, 1]);
  });

  it('cancels unfinished drafts and destroys idempotently', async () => {
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    const { annotator, canvas } = await setup();
    annotator.setTool('rect');
    canvas.dispatchEvent(pointer('pointerdown', 30, 40));
    window.dispatchEvent(pointer('pointermove', 90, 80));

    context.putImageData.mockClear();
    annotator.setTool('arrow');
    expect(context.putImageData).toHaveBeenCalledTimes(1);
    expect(context.getImageData).toHaveBeenCalledTimes(1);

    annotator.destroy();
    expect(() => annotator.destroy()).not.toThrow();
    expect(canvas.isConnected).toBe(false);
    expect(removeWindowListener).toHaveBeenCalledWith('pointerup', expect.any(Function));
  });

  it('discards a canceled touch redaction and accepts the next gesture', async () => {
    const { annotator, canvas } = await setup();
    annotator.setTool('redact');
    canvas.dispatchEvent(pointer('pointerdown', 30, 40, 'touch', 1));
    window.dispatchEvent(pointer('pointermove', 90, 80, 'touch', 1));
    context.putImageData.mockClear();
    window.dispatchEvent(pointer('pointercancel', 90, 80, 'touch', 1));

    expect(context.putImageData).toHaveBeenCalledWith({ marker: 1 }, 0, 0);
    expect(context.getImageData).toHaveBeenCalledTimes(1);

    canvas.dispatchEvent(pointer('pointerdown', 30, 40, 'touch', 2));
    window.dispatchEvent(pointer('pointermove', 90, 80, 'touch', 2));
    window.dispatchEvent(pointer('pointerup', 90, 80, 'touch', 2));
    expect(context.getImageData).toHaveBeenCalledTimes(2);
  });

  it('keeps full resolution and maps coordinates through zoomed canvas bounds', async () => {
    const { annotator, canvas } = await setup();
    annotator.zoomIn();
    expect(annotator.getZoom()).toBe(1.5);
    expect(canvas.style.width).toBe('min(150%, 600px)');
    expect([canvas.width, canvas.height]).toEqual([400, 200]);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 20,
      top: 40,
      width: 300,
      height: 150,
      right: 320,
      bottom: 190,
      x: 20,
      y: 40,
      toJSON: () => ({}),
    });
    drag(canvas, [95, 77.5], [170, 115]);
    expect(context.moveTo).toHaveBeenCalledWith(100, 50);
    expect(context.lineTo).toHaveBeenCalledWith(200, 100);
    expect(context.getImageData).toHaveBeenCalledTimes(2);
    annotator.fitWidth();
    expect(annotator.getZoom()).toBe(1);
  });

  it('keeps a zoom selection made before the screenshot finishes loading', async () => {
    const container = document.querySelector<HTMLElement>('#container')!;
    const annotator = createAnnotator(container, 'data:image/png;base64,source');
    annotator.zoomIn();
    await Promise.resolve();
    const canvas = container.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([400, 200]);
    expect(canvas.style.width).toBe('min(150%, 600px)');
    expect(annotator.getZoom()).toBe(1.5);
  });

  it('pans without drawing, rolls back a canceled pan, and resets the view', async () => {
    const { annotator, canvas } = await setup();
    const stage = canvas.parentElement!;
    Object.defineProperties(stage, {
      clientWidth: { value: 200 },
      clientHeight: { value: 100 },
    });
    stage.scrollLeft = 50;
    stage.scrollTop = 80;
    annotator.setTool('pan');
    canvas.dispatchEvent(pointer('pointerdown', 100, 100, 'touch'));
    window.dispatchEvent(pointer('pointermove', 70, 60, 'touch'));
    expect([stage.scrollLeft, stage.scrollTop]).toEqual([80, 120]);
    window.dispatchEvent(pointer('pointercancel', 70, 60, 'touch'));
    expect([stage.scrollLeft, stage.scrollTop]).toEqual([50, 80]);
    canvas.dispatchEvent(pointer('pointerdown', 100, 100, 'touch', 2));
    window.dispatchEvent(pointer('pointermove', 70, 60, 'touch', 2));
    window.dispatchEvent(pointer('pointerup', 70, 60, 'touch', 2));
    expect([stage.scrollLeft, stage.scrollTop]).toEqual([80, 120]);
    expect(context.getImageData).toHaveBeenCalledTimes(1);
    expect(context.stroke).not.toHaveBeenCalled();
    annotator.resetView();
    expect([stage.scrollLeft, stage.scrollTop, annotator.getZoom()]).toEqual([0, 0, 1]);
  });
});
