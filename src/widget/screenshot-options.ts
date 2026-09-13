import {
  beginViewportCapture,
  canCaptureViewportNatively,
  getRedactionCount,
  isFullPageDisabled,
} from './screenshot';
import { createModal, redactionNoteHtml } from './ui';
import { escapeWidgetText, t } from './i18n';

export type ScreenshotChoice =
  | { kind: 'skip' }
  | { kind: 'capture' }
  | { kind: 'element' }
  | { kind: 'area' }
  | { kind: 'cancel' }
  | { kind: 'viewport'; capture: Promise<string> };

export function showScreenshotOptions(
  root: HTMLElement,
  opts?: { allowSkip?: boolean }
): Promise<ScreenshotChoice> {
  const fullPageDisabled = isFullPageDisabled();
  const nativeViewportAvailable = canCaptureViewportNatively();
  const allowSkip = opts?.allowSkip !== false;

  let redactionNote = '';
  if (getRedactionCount() > 0) {
    redactionNote = redactionNoteHtml(t().redactionReviewNote);
  }

  return new Promise(resolve => {
    const complexNote = fullPageDisabled
      ? `<p style="margin: 0 0 12px; padding: 8px 12px; background: var(--bd-bg-secondary, #f5f5f5); border-radius: 6px; font-size: 13px; color: var(--bd-text-secondary);">${nativeViewportAvailable ? escapeWidgetText(t().pageTooComplexViewportNote) : escapeWidgetText(t().pageTooComplexElementNote)}</p>`
      : '';

    let primaryCaptureButton = '';
    if (!fullPageDisabled) {
      primaryCaptureButton = `<button class="bd-btn bd-btn-primary" data-action="capture">${escapeWidgetText(t().fullPage)}</button>`;
    }

    const modal = createModal(
      root,
      t().captureScreenshotTitle,
      `
        <p style="margin: 0 0 16px; color: var(--bd-text-secondary);">${escapeWidgetText(t().chooseWhatToCapture)}</p>
        ${complexNote}
        ${redactionNote}
        <div class="bd-actions bd-screenshot-actions">
          ${primaryCaptureButton}
          ${fullPageDisabled ? '' : `<button class="bd-btn bd-btn-secondary" data-action="area">${escapeWidgetText(t().selectArea)}</button>`}
          <button class="bd-btn bd-btn-secondary" data-action="element">${escapeWidgetText(t().selectElement)}</button>
          ${allowSkip ? `<button class="bd-btn bd-btn-quiet" data-action="skip">${escapeWidgetText(t().skipScreenshot)}</button>` : ''}
        </div>
        ${nativeViewportAvailable ? `<p style="text-align: center; margin: 16px 0 0;"><a href="#" data-action="viewport" style="color: var(--bd-text-secondary); text-decoration: underline; text-underline-offset: 3px; font-size: 13px;">${escapeWidgetText(t().viewportCaptureAlternative)}</a></p>` : ''}
      `
    );

    const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
    const skipBtn = modal.querySelector('[data-action="skip"]') as HTMLElement | null;
    const elementBtn = modal.querySelector('[data-action="element"]') as HTMLElement;
    const areaBtn = modal.querySelector('[data-action="area"]') as HTMLElement;
    const captureBtn = modal.querySelector('[data-action="capture"]') as HTMLElement;
    const viewportBtn = modal.querySelector('[data-action="viewport"]') as HTMLElement;

    closeBtn?.addEventListener('click', () => {
      modal.remove();
      resolve({ kind: 'cancel' });
    });

    skipBtn?.addEventListener('click', () => {
      modal.remove();
      resolve({ kind: 'skip' });
    });

    elementBtn?.addEventListener('click', () => {
      modal.remove();
      resolve({ kind: 'element' });
    });

    areaBtn?.addEventListener('click', () => {
      modal.remove();
      resolve({ kind: 'area' });
    });

    captureBtn?.addEventListener('click', () => {
      modal.remove();
      resolve({ kind: 'capture' });
    });

    viewportBtn?.addEventListener('click', event => {
      event.preventDefault();
      modal.remove();
      // beginViewportCapture must run synchronously inside the click handler to
      // preserve the user gesture required by getDisplayMedia. The in-flight
      // promise is then handed to capture-flow for awaiting.
      const capture = beginViewportCapture();
      capture.catch(() => {
        // Attach a handler immediately so an early rejection does not surface
        // as 'Unhandled promise rejection' in the brief window before the
        // caller awaits this promise. The real error is still raised on await.
      });
      resolve({ kind: 'viewport', capture });
    });
  });
}
