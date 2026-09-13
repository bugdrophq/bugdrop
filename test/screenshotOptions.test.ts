// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const screenshotMocks = vi.hoisted(() => ({
  beginViewportCapture: vi.fn<() => Promise<string>>(),
  canCaptureViewportNatively: vi.fn(),
  getRedactionCount: vi.fn(),
  isFullPageDisabled: vi.fn(),
}));

vi.mock('../src/widget/screenshot', () => screenshotMocks);

async function choose(action: string, opts?: { allowSkip?: boolean }) {
  const root = document.createElement('div');
  document.body.append(root);
  const { showScreenshotOptions } = await import('../src/widget/screenshot-options');
  const result = showScreenshotOptions(root, opts);
  const button = root.querySelector<HTMLElement>(`[data-action="${action}"]`);
  expect(button).not.toBeNull();
  button?.click();
  return { choice: await result, root };
}

beforeEach(() => {
  screenshotMocks.isFullPageDisabled.mockReturnValue(false);
  screenshotMocks.canCaptureViewportNatively.mockReturnValue(false);
  screenshotMocks.getRedactionCount.mockReturnValue(0);
  screenshotMocks.beginViewportCapture.mockResolvedValue('viewport-image');
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof matchMedia;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('screenshot options', () => {
  it.each([
    ['capture', 'capture'],
    ['area', 'area'],
    ['element', 'element'],
    ['skip', 'skip'],
  ] as const)('resolves %s and removes its modal', async (action, kind) => {
    const { choice, root } = await choose(action);
    expect(choice).toEqual({ kind });
    expect(root.querySelector('.bd-overlay')).toBeNull();
  });

  it('cancels from close and omits skip when screenshots are required', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const { showScreenshotOptions } = await import('../src/widget/screenshot-options');
    const result = showScreenshotOptions(root, { allowSkip: false });

    expect(root.querySelector('[data-action="skip"]')).toBeNull();
    root.querySelector<HTMLElement>('.bd-close')?.click();
    await expect(result).resolves.toEqual({ kind: 'cancel' });
    expect(root.querySelector('.bd-overlay')).toBeNull();
  });

  it('shows only element fallback and escaped privacy guidance on complex pages', async () => {
    screenshotMocks.isFullPageDisabled.mockReturnValue(true);
    screenshotMocks.getRedactionCount.mockReturnValue(3);
    const root = document.createElement('div');
    document.body.append(root);
    const { showScreenshotOptions } = await import('../src/widget/screenshot-options');
    const result = showScreenshotOptions(root);

    expect(root.textContent).toContain('Select a specific element instead.');
    expect(root.textContent).toContain('marked some fields for redaction');
    expect(root.querySelector('[data-action="capture"]')).toBeNull();
    expect(root.querySelector('[data-action="viewport"]')).toBeNull();
    expect(root.querySelector('[data-action="area"]')).toBeNull();
    root.querySelector<HTMLElement>('[data-action="element"]')?.click();
    await expect(result).resolves.toEqual({ kind: 'element' });
  });

  it('hides the viewport link when native capture is unavailable on ordinary pages', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const { showScreenshotOptions } = await import('../src/widget/screenshot-options');
    const result = showScreenshotOptions(root);
    expect(root.querySelector('[data-action="viewport"]')).toBeNull();
    root.querySelector<HTMLElement>('[data-action="skip"]')?.click();
    await expect(result).resolves.toEqual({ kind: 'skip' });
  });

  it('offers viewport capture alongside DOM capture on ordinary pages', async () => {
    screenshotMocks.canCaptureViewportNatively.mockReturnValue(true);
    const root = document.createElement('div');
    document.body.append(root);
    const { showScreenshotOptions } = await import('../src/widget/screenshot-options');
    const result = showScreenshotOptions(root);
    for (const action of ['capture', 'viewport', 'area', 'element']) {
      expect(root.querySelector(`[data-action="${action}"]`)).not.toBeNull();
    }
    expect(root.textContent).not.toContain('cannot apply automatic private-field masks');
    const viewport = root.querySelector('[data-action="viewport"]')!;
    expect(viewport.tagName).toBe('A');
    expect(viewport.textContent).toBe('Screenshot Issues? Capture Viewport instead');
    expect(viewport.closest('.bd-actions')).toBeNull();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    viewport.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(screenshotMocks.beginViewportCapture).toHaveBeenCalledTimes(1);
    expect(await result).toMatchObject({ kind: 'viewport' });
  });

  it('starts viewport capture inside the click and returns the same delayed promise', async () => {
    screenshotMocks.isFullPageDisabled.mockReturnValue(true);
    screenshotMocks.canCaptureViewportNatively.mockReturnValue(true);
    let resolveCapture!: (value: string) => void;
    const capture = new Promise<string>(resolve => {
      resolveCapture = resolve;
    });
    screenshotMocks.beginViewportCapture.mockReturnValue(capture);
    const root = document.createElement('div');
    document.body.append(root);
    const { showScreenshotOptions } = await import('../src/widget/screenshot-options');
    const result = showScreenshotOptions(root);

    expect(root.textContent).not.toContain('cannot apply automatic private-field masks');
    const viewport = root.querySelector('[data-action="viewport"]')!;
    expect(viewport.tagName).toBe('A');
    expect(viewport.textContent).toBe('Screenshot Issues? Capture Viewport instead');
    expect(viewport.closest('.bd-actions')).toBeNull();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    viewport.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(screenshotMocks.beginViewportCapture).toHaveBeenCalledTimes(1);
    const choice = await result;
    expect(choice).toEqual({ kind: 'viewport', capture });
    resolveCapture('delayed-image');
    if (choice.kind === 'viewport') await expect(choice.capture).resolves.toBe('delayed-image');
  });

  it('handles an immediate viewport rejection without changing the returned failure', async () => {
    screenshotMocks.isFullPageDisabled.mockReturnValue(true);
    screenshotMocks.canCaptureViewportNatively.mockReturnValue(true);
    const failure = Promise.reject(new Error('capture denied'));
    screenshotMocks.beginViewportCapture.mockReturnValue(failure);

    const { choice } = await choose('viewport');
    expect(screenshotMocks.beginViewportCapture).toHaveBeenCalledTimes(1);
    if (choice.kind !== 'viewport') throw new Error('Expected viewport choice');
    await expect(choice.capture).rejects.toThrow('capture denied');
  });
});
