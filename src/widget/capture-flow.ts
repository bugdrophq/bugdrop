/* eslint-disable max-lines */
import { createAreaPicker } from './area-picker';
import { showAnnotationStep } from './annotation-flow';
import {
  captureAreaWithLoading,
  capturePromiseWithLoading,
  captureWithLoading,
} from './capture-loading';
import { getElementContextCaptureTarget } from './element-context';
import { createElementPicker } from './picker';
import { getElementSelector, getFullElementSelector } from './selector-metadata';
import { getRedactionCount, isFullPageDisabled } from './screenshot';
import { showScreenshotOptions, type ScreenshotChoice } from './screenshot-options';
import { DEFAULT_SELECTED_ELEMENT_SCREENSHOT_PIXEL_RATIO } from '../defaults';
import { abortableCapture } from './capture-cancellation';
import {
  assertNever,
  emptyCaptureResult,
  emptyElementMetadata,
  shouldRememberComplexScreenshotSkip,
} from './capture-flow-result';
import { getCapturePickerStyle } from './capture-flow-style';
import { constrainScreenshotSize } from './screenshot-size';

export interface CaptureFlowConfig {
  screenshotMode: 'optional' | 'auto' | 'required';
  maxScreenshotSizeBytes?: number;
  screenshotScale?: number;
  elementContextMaxArea?: number;
  accentColor?: string;
  font?: string;
  radius?: string;
  borderWidth?: string;
  bgColor?: string;
  textColor?: string;
  borderColor?: string;
  theme: 'light' | 'dark' | 'auto';
}

export interface CaptureFlowResult {
  screenshot: string | null;
  elementSelector: string | null;
  fullElementSelector: string | null;
  returnToForm: boolean;
}

export type EmptyCaptureReason = 'none' | 'explicit-skip' | 'capture-failure-skip';

type ElementMetadata = Pick<CaptureFlowResult, 'elementSelector' | 'fullElementSelector'>;
type ChosenCaptureResult =
  | ({
      kind: 'captured';
      screenshot: string;
      redactionCount: number;
      redactionUnavailable: boolean;
      redactionLimitations: boolean;
    } & ElementMetadata)
  | { kind: 'returnToForm' }
  | { kind: 'chooseAgain' }
  | ({
      kind: 'empty';
      reason: EmptyCaptureReason;
    } & ElementMetadata);

export async function runScreenshotCaptureFlow(
  root: HTMLElement,
  config: CaptureFlowConfig,
  includeScreenshot: boolean,
  onComplexScreenshotSkipped: () => void,
  signal?: AbortSignal
): Promise<CaptureFlowResult> {
  if (signal?.aborted) return { ...emptyCaptureResult(), returnToForm: true };
  const operation = runScreenshotCaptureFlowInternal(
    root,
    config,
    includeScreenshot,
    onComplexScreenshotSkipped,
    signal
  );
  return signal
    ? abortableCapture(root, operation, signal, { ...emptyCaptureResult(), returnToForm: true })
    : operation;
}

async function runScreenshotCaptureFlowInternal(
  root: HTMLElement,
  config: CaptureFlowConfig,
  includeScreenshot: boolean,
  onComplexScreenshotSkipped: () => void,
  signal?: AbortSignal
): Promise<CaptureFlowResult> {
  if (config.screenshotMode === 'auto') return captureAutomaticScreenshot(root, config, signal);

  if (!includeScreenshot) return emptyCaptureResult();

  const screenshotRequired = config.screenshotMode === 'required';
  while (true) {
    const result = await captureChosenScreenshot(root, config, screenshotRequired, signal);
    if (signal?.aborted) return { ...emptyCaptureResult(), returnToForm: true };
    if (result.kind === 'returnToForm') {
      return { ...emptyCaptureResult(), returnToForm: true };
    }
    if (result.kind === 'chooseAgain') continue;

    if (result.kind === 'empty') {
      if (!screenshotRequired && shouldRememberComplexScreenshotSkip(result.reason)) {
        onComplexScreenshotSkipped();
      }
      if (screenshotRequired) continue;
      return {
        screenshot: null,
        elementSelector: result.elementSelector,
        fullElementSelector: result.fullElementSelector,
        returnToForm: false,
      };
    }

    const annotatedScreenshot = await showAnnotationStep(
      root,
      result.screenshot,
      result.redactionCount,
      {
        redactionUnavailable: result.redactionUnavailable,
        ...(result.redactionLimitations ? { redactionLimitations: true } : {}),
        ...(result.elementSelector ? { selectedElementCapture: true } : {}),
      }
    );
    if (signal?.aborted) return { ...emptyCaptureResult(), returnToForm: true };

    if (annotatedScreenshot === 'retake') continue;
    if (annotatedScreenshot === 'cancel') {
      return { ...emptyCaptureResult(), returnToForm: true };
    }

    return {
      screenshot: await constrainScreenshotSize(annotatedScreenshot, config.maxScreenshotSizeBytes),
      elementSelector: result.elementSelector,
      fullElementSelector: result.fullElementSelector,
      returnToForm: false,
    };
  }
}

async function captureAutomaticScreenshot(
  root: HTMLElement,
  config: CaptureFlowConfig,
  signal?: AbortSignal
): Promise<CaptureFlowResult> {
  if (isFullPageDisabled()) {
    return emptyCaptureResult();
  }

  const result = await captureWithLoading(root, undefined, config.screenshotScale, {
    allowChooseAgain: false,
    signal,
  });
  if (result.kind === 'cancelled') {
    return { ...emptyCaptureResult(), returnToForm: true };
  }

  return {
    screenshot:
      result.kind === 'ok'
        ? await constrainScreenshotSize(result.dataUrl, config.maxScreenshotSizeBytes)
        : null,
    elementSelector: null,
    fullElementSelector: null,
    returnToForm: false,
  };
}

export { shouldRememberComplexScreenshotSkip } from './capture-flow-result';

async function captureChosenScreenshot(
  root: HTMLElement,
  config: CaptureFlowConfig,
  screenshotRequired: boolean,
  signal?: AbortSignal
): Promise<ChosenCaptureResult> {
  const screenshotChoice = await showScreenshotOptions(root, {
    allowSkip: !screenshotRequired,
  });

  switch (screenshotChoice.kind) {
    case 'cancel':
      return { kind: 'returnToForm' };
    case 'skip':
      return emptyChosenCaptureResult('explicit-skip');
    case 'viewport':
      return captureFromViewportChoice(root, screenshotChoice, screenshotRequired, signal);
    case 'capture':
      return captureFromFullPageChoice(root, config, screenshotRequired, signal);
    case 'element':
      return captureFromElementChoice(root, config, screenshotRequired, signal);
    case 'area':
      return captureFromAreaChoice(root, config, screenshotRequired, signal);
    default:
      return assertNever(screenshotChoice);
  }
}

async function captureFromViewportChoice(
  root: HTMLElement,
  choice: Extract<ScreenshotChoice, { kind: 'viewport' }>,
  screenshotRequired: boolean,
  signal?: AbortSignal
): Promise<ChosenCaptureResult> {
  const result = await capturePromiseWithLoading(root, choice.capture, {
    allowSkip: !screenshotRequired,
    showLoading: false,
    signal,
  });
  if (result.kind === 'cancelled') return { kind: 'returnToForm' };
  if (result.kind === 'choose-again') return { kind: 'chooseAgain' };
  if (result.kind === 'skipped') {
    return emptyChosenCaptureResult('capture-failure-skip');
  }
  return {
    kind: 'captured',
    screenshot: result.dataUrl,
    elementSelector: null,
    fullElementSelector: null,
    redactionCount: 0,
    redactionUnavailable: true,
    redactionLimitations: false,
  };
}

async function captureFromFullPageChoice(
  root: HTMLElement,
  config: CaptureFlowConfig,
  screenshotRequired: boolean,
  signal?: AbortSignal
): Promise<ChosenCaptureResult> {
  const result = await captureWithLoading(root, undefined, config.screenshotScale, {
    allowSkip: !screenshotRequired,
    signal,
  });
  if (result.kind === 'cancelled') return { kind: 'returnToForm' };
  if (result.kind === 'choose-again') return { kind: 'chooseAgain' };
  if (result.kind === 'skipped') {
    return emptyChosenCaptureResult('capture-failure-skip');
  }
  return {
    kind: 'captured',
    screenshot: result.dataUrl,
    elementSelector: null,
    fullElementSelector: null,
    redactionCount: result.redaction?.count ?? 0,
    redactionUnavailable: false,
    redactionLimitations: result.redaction?.hasLimitations ?? false,
  };
}

async function captureFromElementChoice(
  root: HTMLElement,
  config: CaptureFlowConfig,
  screenshotRequired: boolean,
  signal?: AbortSignal
): Promise<ChosenCaptureResult> {
  const element = await createElementPicker(getCapturePickerStyle(config), signal);
  if (!element) {
    return { kind: 'chooseAgain' };
  }

  const elementMetadata = {
    elementSelector: getElementSelector(element),
    fullElementSelector: getFullElementSelector(element),
  };
  const captureTarget = getElementContextCaptureTarget(element, {
    maxViewportAreaMultiplier: config.elementContextMaxArea,
  });
  const result = await captureWithLoading(root, captureTarget, config.screenshotScale, {
    allowSkip: !screenshotRequired,
    captureOptions: {
      highlightElement: element,
      highlightStyle: {
        accentColor: config.accentColor,
        radius: config.radius,
        borderWidth: config.borderWidth,
      },
      pixelRatio: DEFAULT_SELECTED_ELEMENT_SCREENSHOT_PIXEL_RATIO,
    },
    signal,
  });
  if (result.kind === 'cancelled') return { kind: 'returnToForm' };
  if (result.kind === 'choose-again') return { kind: 'chooseAgain' };
  if (result.kind === 'skipped') {
    return emptyChosenCaptureResult('capture-failure-skip', elementMetadata);
  }
  return {
    kind: 'captured',
    screenshot: result.dataUrl,
    ...elementMetadata,
    redactionCount: result.redaction?.count ?? 0,
    redactionUnavailable: false,
    redactionLimitations: result.redaction?.hasLimitations ?? false,
  };
}

async function captureFromAreaChoice(
  root: HTMLElement,
  config: CaptureFlowConfig,
  screenshotRequired: boolean,
  signal?: AbortSignal
): Promise<ChosenCaptureResult> {
  const rect = await createAreaPicker(
    getCapturePickerStyle(config),
    {
      redactionsAvailable: getRedactionCount() > 0,
    },
    signal
  );
  if (!rect) {
    return { kind: 'chooseAgain' };
  }

  const result = await captureAreaWithLoading(root, rect, config.screenshotScale, {
    allowSkip: !screenshotRequired,
    signal,
  });
  if (result.kind === 'cancelled') return { kind: 'returnToForm' };
  if (result.kind === 'choose-again') return { kind: 'chooseAgain' };
  if (result.kind === 'skipped') {
    return emptyChosenCaptureResult('capture-failure-skip');
  }
  return {
    kind: 'captured',
    screenshot: result.dataUrl,
    elementSelector: null,
    fullElementSelector: null,
    redactionCount: result.redaction?.count ?? 0,
    redactionUnavailable: false,
    redactionLimitations: result.redaction?.hasLimitations ?? false,
  };
}

function emptyChosenCaptureResult(
  reason: EmptyCaptureReason,
  metadata: ElementMetadata = emptyElementMetadata()
): ChosenCaptureResult {
  return { kind: 'empty', reason, ...metadata };
}
