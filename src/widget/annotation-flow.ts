import { createAnnotator, type Tool } from './annotator';
import { createModal, redactionNoteHtml } from './ui';
import { escapeWidgetText, t } from './i18n';

export function showAnnotationStep(
  root: HTMLElement,
  screenshot: string,
  redactionCount = 0,
  opts?: {
    redactionUnavailable?: boolean;
    redactionLimitations?: boolean;
    selectedElementCapture?: boolean;
  }
): Promise<string | 'retake' | 'cancel'> {
  return new Promise(resolve => {
    const redactionMessages: string[] = [];
    if (opts?.redactionUnavailable) {
      redactionMessages.push(t().viewportRedactionUnavailableNote);
    } else {
      if (redactionCount > 0) {
        redactionMessages.push(t().redactionCountNote(redactionCount));
      }
      if (opts?.redactionLimitations) {
        redactionMessages.push(t().redactionLimitationsNote);
      }
    }
    const redactionNote = redactionMessages.length
      ? redactionNoteHtml(redactionMessages.join(' '))
      : '';
    const configLinkHtml =
      '<a href="https://bugdrop.dev/docs/configuration#select-element-screenshots" target="_blank" rel="noopener noreferrer">data-element-context-max-area</a>';
    const selectedElementNote = opts?.selectedElementCapture
      ? `
        <p class="bd-selected-element-note" style="margin: -4px 0 12px; color: var(--bd-text-secondary); font-size: 13px;">
          ${t().selectedElementNote(configLinkHtml)}
        </p>
      `
      : '';
    const modal = createModal(
      root,
      t().reviewScreenshotTitle,
      `
        ${redactionNote}
        <p style="margin: 0 0 12px; color: var(--bd-text-secondary); font-size: 13px;">
          ${escapeWidgetText(t().annotationInstruction)}
        </p>
        ${selectedElementNote}
        <div class="bd-tools">
          <button class="bd-tool active" data-tool="draw">✏️ ${escapeWidgetText(t().toolDraw)}</button>
          <button class="bd-tool" data-tool="arrow">➡️ ${escapeWidgetText(t().toolArrow)}</button>
          <button class="bd-tool" data-tool="rect">▢ ${escapeWidgetText(t().toolRectangle)}</button>
          <button class="bd-tool" data-tool="redact">${escapeWidgetText(t().toolRedact)}</button>
          <button class="bd-tool" data-tool="pan">✋ ${escapeWidgetText(t().toolPan)}</button>
          <button class="bd-tool" data-action="undo">↶ ${escapeWidgetText(t().undo)}</button>
        </div>
        <div class="bd-view-controls">
          <button class="bd-tool" data-view="fit">${escapeWidgetText(t().fitWidth)}</button>
          <button class="bd-tool" data-view="out" aria-label="${escapeWidgetText(t().zoomOut)}">−</button>
          <output class="bd-zoom-level" aria-live="polite">100%</output>
          <button class="bd-tool" data-view="in" aria-label="${escapeWidgetText(t().zoomIn)}">+</button>
          <button class="bd-tool" data-view="reset">${escapeWidgetText(t().resetView)}</button>
        </div>
        <div id="annotation-canvas" class="bd-annotation-stage"></div>
        <div class="bd-actions">
          <button class="bd-btn bd-btn-secondary" data-action="retake">${escapeWidgetText(t().retake)}</button>
          <button class="bd-btn bd-btn-primary" data-action="done">${escapeWidgetText(t().submitFeedback)}</button>
        </div>
      `,
      false,
      'bd-modal--annotator'
    );

    const canvasContainer = modal.querySelector('#annotation-canvas') as HTMLElement;
    const annotator = createAnnotator(canvasContainer, screenshot);

    const zoomLevel = modal.querySelector('.bd-zoom-level') as HTMLOutputElement;
    modal.querySelectorAll<HTMLElement>('[data-view]').forEach(button => {
      button.addEventListener('click', () => {
        switch (button.dataset.view) {
          case 'fit':
            annotator.fitWidth();
            break;
          case 'in':
            annotator.zoomIn();
            break;
          case 'out':
            annotator.zoomOut();
            break;
          case 'reset':
            annotator.resetView();
            break;
        }
        zoomLevel.value = `${Math.round(annotator.getZoom() * 100)}%`;
      });
    });

    const toolButtons = modal.querySelectorAll('[data-tool]');
    toolButtons.forEach(btn => {
      btn.addEventListener('click', e => {
        const target = e.currentTarget as HTMLElement;
        const tool = target.dataset.tool;

        if (tool) {
          toolButtons.forEach(b => b.classList.remove('active'));
          target.classList.add('active');
          annotator.setTool(tool as Tool);
        }
      });
    });

    const undoBtn = modal.querySelector('[data-action="undo"]') as HTMLElement | null;
    undoBtn?.addEventListener('click', () => annotator.undo());

    const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
    const retakeBtn = modal.querySelector('[data-action="retake"]') as HTMLElement;
    const doneBtn = modal.querySelector('[data-action="done"]') as HTMLElement;

    closeBtn?.addEventListener('click', () => {
      annotator.destroy();
      modal.remove();
      resolve('cancel');
    });

    retakeBtn?.addEventListener('click', () => {
      annotator.destroy();
      modal.remove();
      resolve('retake');
    });

    doneBtn?.addEventListener('click', () => {
      const annotated = annotator.getImageData();
      annotator.destroy();
      modal.remove();
      resolve(annotated);
    });
  });
}
