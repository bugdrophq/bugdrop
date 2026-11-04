// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmptyCaptureReason } from '../src/widget/capture-flow';
import type { ScreenshotChoice } from '../src/widget/screenshot-options';
import type { CaptureWithLoadingResult } from '../src/widget/capture-loading';
import {
  DEFAULT_SELECTED_ELEMENT_CONTEXT_MAX_VIEWPORT_AREA_MULTIPLIER,
  DEFAULT_SELECTED_ELEMENT_SCREENSHOT_PIXEL_RATIO,
} from '../src/defaults';

const baseConfig = {
  screenshotMode: 'optional' as const,
  theme: 'light' as const,
};

function rect(width: number, height: number, x = 0, y = 0): DOMRect {
  return {
    x,
    y,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

async function loadCaptureFlowWithMocks(opts: {
  screenshotChoice?: ScreenshotChoice;
  screenshotChoices?: ScreenshotChoice[];
  pickedElement?: Element | null;
  pickedElements?: Array<Element | null>;
  pickedArea?: DOMRect | null;
  pickedAreas?: Array<DOMRect | null>;
  captureResult?: CaptureWithLoadingResult;
  captureResults?: CaptureWithLoadingResult[];
  areaCaptureResult?: CaptureWithLoadingResult;
  areaCaptureResults?: CaptureWithLoadingResult[];
  annotationResult?: string | 'retake' | 'cancel';
  annotationResults?: Array<string | 'retake' | 'cancel'>;
}) {
  vi.resetModules();
  const screenshotOptionsMock = vi.fn();
  for (const choice of opts.screenshotChoices ?? []) {
    screenshotOptionsMock.mockResolvedValueOnce(choice);
  }
  screenshotOptionsMock.mockResolvedValue(opts.screenshotChoice ?? { kind: 'skip' });

  const elementPickerMock = vi.fn();
  for (const element of opts.pickedElements ?? []) {
    elementPickerMock.mockResolvedValueOnce(element);
  }
  elementPickerMock.mockResolvedValue(opts.pickedElement ?? null);

  const areaPickerMock = vi.fn();
  for (const area of opts.pickedAreas ?? []) {
    areaPickerMock.mockResolvedValueOnce(area);
  }
  areaPickerMock.mockResolvedValue(opts.pickedArea ?? null);

  const captureWithLoadingMock = vi.fn();
  for (const result of opts.captureResults ?? []) {
    captureWithLoadingMock.mockResolvedValueOnce(result);
  }
  captureWithLoadingMock.mockResolvedValue(opts.captureResult ?? { kind: 'skipped' });
  const captureAreaWithLoadingMock = vi.fn();
  for (const result of opts.areaCaptureResults ?? []) {
    captureAreaWithLoadingMock.mockResolvedValueOnce(result);
  }
  captureAreaWithLoadingMock.mockResolvedValue(opts.areaCaptureResult ?? { kind: 'skipped' });

  const annotationMock = vi.fn();
  for (const result of opts.annotationResults ?? []) {
    annotationMock.mockResolvedValueOnce(result);
  }
  annotationMock.mockResolvedValue(opts.annotationResult ?? 'annotated-image');

  vi.doMock('../src/widget/screenshot-options', () => ({
    showScreenshotOptions: screenshotOptionsMock,
  }));
  vi.doMock('../src/widget/picker', () => ({
    createElementPicker: elementPickerMock,
  }));
  vi.doMock('../src/widget/area-picker', () => ({
    createAreaPicker: areaPickerMock,
  }));
  vi.doMock('../src/widget/capture-loading', () => ({
    captureWithLoading: captureWithLoadingMock,
    captureAreaWithLoading: captureAreaWithLoadingMock,
    capturePromiseWithLoading: captureWithLoadingMock,
  }));
  vi.doMock('../src/widget/annotation-flow', () => ({
    showAnnotationStep: annotationMock,
  }));
  vi.doMock('../src/widget/screenshot', () => ({
    beginViewportCapture: vi.fn(),
    getRedactionCount: vi.fn().mockReturnValue(0),
    isFullPageDisabled: vi.fn().mockReturnValue(false),
  }));

  return {
    ...(await import('../src/widget/capture-flow')),
    screenshotOptionsMock,
    captureWithLoadingMock,
    captureAreaWithLoadingMock,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.doUnmock('../src/widget/screenshot-options');
  vi.doUnmock('../src/widget/picker');
  vi.doUnmock('../src/widget/area-picker');
  vi.doUnmock('../src/widget/capture-loading');
  vi.doUnmock('../src/widget/annotation-flow');
  vi.doUnmock('../src/widget/screenshot');
  vi.resetModules();
});

describe('capture flow state decisions', () => {
  it.each([
    ['explicit-skip', true],
    ['capture-failure-skip', true],
    ['none', false],
  ] satisfies Array<[EmptyCaptureReason, boolean]>)(
    'complex screenshot skip persistence for %s is %s',
    async (reason, expected) => {
      const { shouldRememberComplexScreenshotSkip } = await import('../src/widget/capture-flow');
      expect(shouldRememberComplexScreenshotSkip(reason)).toBe(expected);
    }
  );

  it('remembers complex screenshot skip for an explicit optional skip', async () => {
    const { runScreenshotCaptureFlow } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'skip' },
    });
    const onComplexScreenshotSkipped = vi.fn();

    const result = await runScreenshotCaptureFlow(
      document.createElement('div'),
      baseConfig,
      true,
      onComplexScreenshotSkipped
    );

    expect(result).toEqual({
      screenshot: null,
      elementSelector: null,
      fullElementSelector: null,
      returnToForm: false,
    });
    expect(onComplexScreenshotSkipped).toHaveBeenCalledTimes(1);
  });

  describe.each(['element', 'area'] as const)('%s selection cancellation', kind => {
    it.each(['optional', 'required'] as const)(
      'reopens the chooser before returning to the form in %s mode',
      async screenshotMode => {
        const {
          runScreenshotCaptureFlow,
          screenshotOptionsMock,
          captureWithLoadingMock,
          captureAreaWithLoadingMock,
        } = await loadCaptureFlowWithMocks({
          screenshotChoices: [{ kind }],
          screenshotChoice: { kind: 'cancel' },
        });
        const onComplexScreenshotSkipped = vi.fn();

        const result = await runScreenshotCaptureFlow(
          document.createElement('div'),
          { ...baseConfig, screenshotMode },
          true,
          onComplexScreenshotSkipped
        );

        expect(result).toEqual({
          screenshot: null,
          elementSelector: null,
          fullElementSelector: null,
          returnToForm: true,
        });
        expect(screenshotOptionsMock).toHaveBeenCalledTimes(2);
        expect(screenshotOptionsMock).toHaveBeenLastCalledWith(expect.anything(), {
          allowSkip: screenshotMode === 'optional',
        });
        expect(captureWithLoadingMock).not.toHaveBeenCalled();
        expect(captureAreaWithLoadingMock).not.toHaveBeenCalled();
        expect(onComplexScreenshotSkipped).not.toHaveBeenCalled();
      }
    );

    it('continues only after an explicit optional skip', async () => {
      const { runScreenshotCaptureFlow, screenshotOptionsMock } = await loadCaptureFlowWithMocks({
        screenshotChoices: [{ kind }],
        screenshotChoice: { kind: 'skip' },
      });
      const onComplexScreenshotSkipped = vi.fn();

      const result = await runScreenshotCaptureFlow(
        document.createElement('div'),
        baseConfig,
        true,
        onComplexScreenshotSkipped
      );

      expect(screenshotOptionsMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        screenshot: null,
        elementSelector: null,
        fullElementSelector: null,
        returnToForm: false,
      });
      expect(onComplexScreenshotSkipped).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps selected element metadata when element capture is skipped after failure', async () => {
    document.body.innerHTML = `
      <div class="injected-before-page"></div>
      <div class="another-injected-wrapper"></div>
      <div id="page" class="site">
        <div id="content" class="site-content">
          <div id="primary" class="content-area">
            <main id="main" class="site-main">
              <article id="post-27" class="post-27 page">
                <div class="inside-article">
                  <div class="entry-content">
                    <div class="gb-container gb-container-f0cc8c05"></div>
                    <div class="gb-container gb-container-928af62b"></div>
                  </div>
                </div>
              </article>
            </main>
          </div>
        </div>
      </div>
    `;
    const element = document.querySelector('.gb-container-928af62b')!;
    const { runScreenshotCaptureFlow } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'element' },
      pickedElement: element,
      captureResult: { kind: 'skipped' },
    });
    const onComplexScreenshotSkipped = vi.fn();

    const result = await runScreenshotCaptureFlow(
      document.createElement('div'),
      baseConfig,
      true,
      onComplexScreenshotSkipped
    );

    expect(result).toEqual({
      screenshot: null,
      elementSelector:
        '#post-27 > div.inside-article > div.entry-content > div.gb-container.gb-container-928af62b',
      fullElementSelector:
        'html > body > div#page.site > div#content.site-content > div#primary.content-area > main#main.site-main > article#post-27.post-27.page > div.inside-article > div.entry-content > div.gb-container.gb-container-928af62b:nth-of-type(2)',
      returnToForm: false,
    });
    expect(document.querySelector(result.fullElementSelector!)).toBe(element);
    expect(onComplexScreenshotSkipped).toHaveBeenCalledTimes(1);
  });

  it('captures a surrounding container and highlights the selected element', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    const outerContext = document.createElement('article');
    outerContext.className = 'listing-card';
    outerContext.getBoundingClientRect = () => rect(900, 900);

    const context = document.createElement('section');
    context.className = 'field-group';
    context.getBoundingClientRect = () => rect(500, 300);

    const target = document.createElement('button');
    target.id = 'book-now';
    target.getBoundingClientRect = () => rect(80, 40, 100, 100);
    context.appendChild(target);
    outerContext.appendChild(context);
    document.body.appendChild(outerContext);

    const { runScreenshotCaptureFlow, captureWithLoadingMock } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'element' },
      pickedElement: target,
      captureResult: { kind: 'skipped' },
    });
    const root = document.createElement('div');

    await runScreenshotCaptureFlow(
      root,
      {
        ...baseConfig,
        elementContextMaxArea: 1.5,
      },
      true,
      vi.fn()
    );

    expect(captureWithLoadingMock).toHaveBeenCalledWith(root, outerContext, undefined, {
      allowSkip: true,
      captureOptions: {
        highlightElement: target,
        highlightStyle: {
          accentColor: undefined,
          borderWidth: undefined,
          radius: undefined,
        },
        pixelRatio: DEFAULT_SELECTED_ELEMENT_SCREENSHOT_PIXEL_RATIO,
      },
    });
  });

  it('does not choose a context ancestor that does not visually contain the selected element', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    const overflowParent = document.createElement('section');
    overflowParent.className = 'overflow-parent';
    overflowParent.getBoundingClientRect = () => rect(200, 200, 0, 0);

    const target = document.createElement('button');
    target.id = 'overflowed-target';
    target.getBoundingClientRect = () => rect(80, 40, 300, 300);
    overflowParent.appendChild(target);
    document.body.appendChild(overflowParent);

    const { runScreenshotCaptureFlow, captureWithLoadingMock } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'element' },
      pickedElement: target,
      captureResult: { kind: 'skipped' },
    });

    await runScreenshotCaptureFlow(
      document.createElement('div'),
      {
        ...baseConfig,
        elementContextMaxArea: 1.5,
      },
      true,
      vi.fn()
    );

    expect(captureWithLoadingMock.mock.calls[0]?.[1]).toBe(target);
  });

  it('uses the default selected element context settings when no overrides are provided', () => {
    expect(DEFAULT_SELECTED_ELEMENT_CONTEXT_MAX_VIEWPORT_AREA_MULTIPLIER).toBe(0);
  });

  it('limits selected element context by configured viewport area multiplier', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    const outerContext = document.createElement('article');
    outerContext.className = 'listing-card';
    outerContext.getBoundingClientRect = () => rect(900, 900);

    const context = document.createElement('section');
    context.className = 'field-group';
    context.getBoundingClientRect = () => rect(500, 300);

    const target = document.createElement('button');
    target.id = 'book-now';
    target.getBoundingClientRect = () => rect(80, 40, 100, 100);
    context.appendChild(target);
    outerContext.appendChild(context);
    document.body.appendChild(outerContext);

    const { runScreenshotCaptureFlow, captureWithLoadingMock } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'element' },
      pickedElement: target,
      captureResult: { kind: 'skipped' },
    });

    await runScreenshotCaptureFlow(
      document.createElement('div'),
      {
        ...baseConfig,
        elementContextMaxArea: 0.2,
      },
      true,
      vi.fn()
    );

    expect(captureWithLoadingMock.mock.calls[0]?.[1]).toBe(context);
  });

  it('keeps selected element captures tight by default', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    const context = document.createElement('section');
    context.className = 'field-group';
    context.getBoundingClientRect = () => rect(500, 300);

    const target = document.createElement('button');
    target.id = 'book-now';
    target.getBoundingClientRect = () => rect(80, 40, 100, 100);
    context.appendChild(target);
    document.body.appendChild(context);

    const { runScreenshotCaptureFlow, captureWithLoadingMock } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'element' },
      pickedElement: target,
      captureResult: { kind: 'skipped' },
    });

    await runScreenshotCaptureFlow(document.createElement('div'), baseConfig, true, vi.fn());

    expect(captureWithLoadingMock.mock.calls[0]?.[1]).toBe(target);
  });

  it('passes the selected element when no larger fallback container is useful', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    const target = document.createElement('button');
    target.id = 'book-now';
    target.getBoundingClientRect = () => rect(80, 40, 100, 100);
    document.body.appendChild(target);

    const { runScreenshotCaptureFlow, captureWithLoadingMock } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'element' },
      pickedElement: target,
      captureResult: { kind: 'skipped' },
    });
    const root = document.createElement('div');

    await runScreenshotCaptureFlow(root, baseConfig, true, vi.fn());

    expect(captureWithLoadingMock).toHaveBeenCalledWith(root, target, undefined, {
      allowSkip: true,
      captureOptions: {
        highlightElement: target,
        highlightStyle: {
          accentColor: undefined,
          borderWidth: undefined,
          radius: undefined,
        },
        pixelRatio: DEFAULT_SELECTED_ELEMENT_SCREENSHOT_PIXEL_RATIO,
      },
    });
  });

  it('keeps full selected element metadata after successful element capture', async () => {
    document.body.innerHTML = `
      <main id="content">
        <section class="card">
          <button id="save-button" class="primary action">Save</button>
        </section>
      </main>
    `;
    const element = document.querySelector('#save-button')!;
    const { runScreenshotCaptureFlow } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'element' },
      pickedElement: element,
      captureResult: { kind: 'ok', dataUrl: 'data:image/png;base64,BBBB' },
      annotationResult: 'data:image/png;base64,ANNOTATED',
    });
    const onComplexScreenshotSkipped = vi.fn();

    const result = await runScreenshotCaptureFlow(
      document.createElement('div'),
      baseConfig,
      true,
      onComplexScreenshotSkipped
    );

    expect(result).toEqual({
      screenshot: 'data:image/png;base64,ANNOTATED',
      elementSelector: '#save-button',
      fullElementSelector:
        'html > body > main#content > section.card > button#save-button.primary.action',
      returnToForm: false,
    });
    expect(document.querySelector(result.fullElementSelector!)).toBe(element);
    expect(onComplexScreenshotSkipped).not.toHaveBeenCalled();
  });

  it('uses the latest selected element metadata after annotation retake', async () => {
    document.body.innerHTML = `
      <main>
        <button id="first-button" class="primary">First</button>
        <button id="second-button" class="secondary">Second</button>
      </main>
    `;
    const firstElement = document.querySelector('#first-button')!;
    const secondElement = document.querySelector('#second-button')!;
    const { runScreenshotCaptureFlow } = await loadCaptureFlowWithMocks({
      screenshotChoices: [{ kind: 'element' }, { kind: 'element' }],
      pickedElements: [firstElement, secondElement],
      captureResults: [
        { kind: 'ok', dataUrl: 'data:image/png;base64,FIRST' },
        { kind: 'ok', dataUrl: 'data:image/png;base64,SECOND' },
      ],
      annotationResults: ['retake', 'data:image/png;base64,ANNOTATED_SECOND'],
    });
    const onComplexScreenshotSkipped = vi.fn();

    const result = await runScreenshotCaptureFlow(
      document.createElement('div'),
      baseConfig,
      true,
      onComplexScreenshotSkipped
    );

    expect(result).toEqual({
      screenshot: 'data:image/png;base64,ANNOTATED_SECOND',
      elementSelector: '#second-button',
      fullElementSelector: 'html > body > main > button#second-button.secondary',
      returnToForm: false,
    });
    expect(result.fullElementSelector).not.toContain('first-button');
    expect(document.querySelector(result.fullElementSelector!)).toBe(secondElement);
    expect(onComplexScreenshotSkipped).not.toHaveBeenCalled();
  });

  it('drops selected element metadata when element capture is cancelled', async () => {
    document.body.innerHTML = `
      <main>
        <button id="cancelled-button" class="primary">Cancel target</button>
      </main>
    `;
    const element = document.querySelector('#cancelled-button')!;
    const { runScreenshotCaptureFlow } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'element' },
      pickedElement: element,
      captureResult: { kind: 'cancelled' },
    });
    const onComplexScreenshotSkipped = vi.fn();

    const result = await runScreenshotCaptureFlow(
      document.createElement('div'),
      baseConfig,
      true,
      onComplexScreenshotSkipped
    );

    expect(result).toEqual({
      screenshot: null,
      elementSelector: null,
      fullElementSelector: null,
      returnToForm: true,
    });
    expect(onComplexScreenshotSkipped).not.toHaveBeenCalled();
  });

  it('returns to form when the user dismisses the screenshot options modal', async () => {
    const { runScreenshotCaptureFlow } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'cancel' },
    });
    const onComplexScreenshotSkipped = vi.fn();

    const result = await runScreenshotCaptureFlow(
      document.createElement('div'),
      baseConfig,
      true,
      onComplexScreenshotSkipped
    );

    expect(result).toEqual({
      screenshot: null,
      elementSelector: null,
      fullElementSelector: null,
      returnToForm: true,
    });
    expect(onComplexScreenshotSkipped).not.toHaveBeenCalled();
  });

  it('returns to form when the capture-failure modal is cancelled mid-capture', async () => {
    const { runScreenshotCaptureFlow } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'capture' },
      captureResult: { kind: 'cancelled' },
    });
    const onComplexScreenshotSkipped = vi.fn();

    const result = await runScreenshotCaptureFlow(
      document.createElement('div'),
      baseConfig,
      true,
      onComplexScreenshotSkipped
    );

    expect(result).toEqual({
      screenshot: null,
      elementSelector: null,
      fullElementSelector: null,
      returnToForm: true,
    });
    expect(onComplexScreenshotSkipped).not.toHaveBeenCalled();
  });

  it('returns to screenshot options after a capture failure so another method can be selected', async () => {
    const {
      runScreenshotCaptureFlow,
      screenshotOptionsMock,
      captureWithLoadingMock,
      captureAreaWithLoadingMock,
    } = await loadCaptureFlowWithMocks({
      screenshotChoices: [{ kind: 'capture' }, { kind: 'area' }],
      captureResult: { kind: 'choose-again' } as CaptureWithLoadingResult,
      pickedArea: rect(200, 120, 10, 20),
      areaCaptureResult: { kind: 'ok', dataUrl: 'data:image/png;base64,AREA' },
      annotationResult: 'data:image/png;base64,ANNOTATED_AREA',
    });
    const onComplexScreenshotSkipped = vi.fn();

    const result = await runScreenshotCaptureFlow(
      document.createElement('div'),
      baseConfig,
      true,
      onComplexScreenshotSkipped
    );

    expect(result).toEqual({
      screenshot: 'data:image/png;base64,ANNOTATED_AREA',
      elementSelector: null,
      fullElementSelector: null,
      returnToForm: false,
    });
    expect(screenshotOptionsMock).toHaveBeenCalledTimes(2);
    expect(captureWithLoadingMock).toHaveBeenCalledTimes(1);
    expect(captureAreaWithLoadingMock).toHaveBeenCalledTimes(1);
    expect(onComplexScreenshotSkipped).not.toHaveBeenCalled();
  });

  it('does not offer choose-again recovery for automatic screenshots without a picker', async () => {
    const { runScreenshotCaptureFlow, captureWithLoadingMock, screenshotOptionsMock } =
      await loadCaptureFlowWithMocks({
        captureResult: { kind: 'skipped' },
      });
    const root = document.createElement('div');

    const result = await runScreenshotCaptureFlow(
      root,
      { ...baseConfig, screenshotMode: 'auto' },
      true,
      vi.fn()
    );

    expect(result).toEqual({
      screenshot: null,
      elementSelector: null,
      fullElementSelector: null,
      returnToForm: false,
    });
    expect(screenshotOptionsMock).not.toHaveBeenCalled();
    expect(captureWithLoadingMock).toHaveBeenCalledWith(root, undefined, undefined, {
      allowChooseAgain: false,
    });
  });

  it('returns to form when the annotation step is cancelled', async () => {
    const { runScreenshotCaptureFlow } = await loadCaptureFlowWithMocks({
      screenshotChoice: { kind: 'capture' },
      captureResult: { kind: 'ok', dataUrl: 'data:image/png;base64,AAAA' },
      annotationResult: 'cancel',
    });
    const onComplexScreenshotSkipped = vi.fn();

    const result = await runScreenshotCaptureFlow(
      document.createElement('div'),
      baseConfig,
      true,
      onComplexScreenshotSkipped
    );

    expect(result).toEqual({
      screenshot: null,
      elementSelector: null,
      fullElementSelector: null,
      returnToForm: true,
    });
    expect(onComplexScreenshotSkipped).not.toHaveBeenCalled();
  });

  it('flags redactionUnavailable on the annotation step for native viewport captures', async () => {
    const annotationMock = vi.fn().mockResolvedValue('annotated-image');
    vi.resetModules();
    vi.doMock('../src/widget/screenshot-options', () => ({
      showScreenshotOptions: vi.fn().mockResolvedValue({
        kind: 'viewport',
        capture: Promise.resolve('data:image/png;base64,VVVV'),
      } satisfies ScreenshotChoice),
    }));
    vi.doMock('../src/widget/picker', () => ({ createElementPicker: vi.fn() }));
    vi.doMock('../src/widget/area-picker', () => ({ createAreaPicker: vi.fn() }));
    vi.doMock('../src/widget/capture-loading', () => ({
      captureWithLoading: vi.fn(),
      captureAreaWithLoading: vi.fn(),
      capturePromiseWithLoading: vi
        .fn()
        .mockResolvedValue({ kind: 'ok', dataUrl: 'data:image/png;base64,VVVV' }),
    }));
    vi.doMock('../src/widget/annotation-flow', () => ({ showAnnotationStep: annotationMock }));
    vi.doMock('../src/widget/screenshot', () => ({
      beginViewportCapture: vi.fn(),
      getRedactionCount: vi.fn().mockReturnValue(0),
      isFullPageDisabled: vi.fn().mockReturnValue(true),
    }));

    const { runScreenshotCaptureFlow } = await import('../src/widget/capture-flow');
    const onComplexScreenshotSkipped = vi.fn();

    const result = await runScreenshotCaptureFlow(
      document.createElement('div'),
      baseConfig,
      true,
      onComplexScreenshotSkipped
    );

    expect(result.screenshot).toBe('annotated-image');
    expect(annotationMock).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      'data:image/png;base64,VVVV',
      0,
      { redactionUnavailable: true }
    );
  });
});
