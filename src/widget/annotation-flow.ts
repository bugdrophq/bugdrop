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
      annotationContent(redactionNote, selectedElementNote),
      false,
      'bd-modal--annotator'
    );

    const canvasContainer = modal.querySelector('#annotation-canvas') as HTMLElement;
    const annotator = createAnnotator(canvasContainer, screenshot);
    const modalElement = modal.querySelector('.bd-modal--annotator') as HTMLElement;
    const nav = modal.querySelector('.bd-annotation-nav') as HTMLElement;
    const heading = modal.querySelector('.bd-title') as HTMLElement;
    if (
      window.matchMedia?.('(max-width: 640px), (max-width: 1024px) and (max-height: 500px)').matches
    ) {
      annotator.setTool('pan');
      heading.textContent = t().editScreenshotTitle;
      modal.querySelector('[data-tool="draw"]')?.classList.remove('active');
      modal.querySelector('[data-tool="draw"]')?.setAttribute('aria-pressed', 'false');
      const panButton = modal.querySelector('[data-tool="pan"]');
      panButton?.classList.add('active');
      panButton?.setAttribute('aria-pressed', 'true');
    }

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

    wireAnnotationTools(modal, annotator);

    const closeBtn = modal.querySelector('.bd-close') as HTMLElement;
    const retakeBtn = modal.querySelector('[data-action="retake"]') as HTMLElement;
    const doneBtn = modal.querySelector('[data-action="done"]') as HTMLElement;
    const confirmation = modal.querySelector('.bd-retake-confirm') as HTMLElement;
    const keepEditing = modal.querySelector('[data-action="keep-editing"]') as HTMLElement;
    const confirmRetake = modal.querySelector('[data-action="confirm-retake"]') as HTMLElement;
    let retakeFocus: HTMLElement | null = null;

    function finish(value: string | 'retake' | 'cancel') {
      annotator.destroy();
      modal.remove();
      resolve(value);
    }

    function requestRetake(event: Event) {
      if (!annotator.hasEdits()) {
        finish('retake');
        return;
      }
      retakeFocus = event.currentTarget as HTMLElement;
      confirmation.hidden = false;
      keepEditing.focus();
    }

    function dismissRetake() {
      confirmation.hidden = true;
      retakeFocus?.focus();
    }

    closeBtn?.addEventListener('click', () => {
      finish('cancel');
    });

    retakeBtn?.addEventListener('click', requestRetake);
    modal.querySelector('[data-action="mobile-retake"]')?.addEventListener('click', requestRetake);
    keepEditing.addEventListener('click', dismissRetake);
    confirmRetake.addEventListener('click', () => finish('retake'));
    confirmation.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissRetake();
      } else if (event.key === 'Tab') {
        if (event.shiftKey && event.target === keepEditing) {
          event.preventDefault();
          confirmRetake.focus();
        } else if (!event.shiftKey && event.target === confirmRetake) {
          event.preventDefault();
          keepEditing.focus();
        }
      }
    });

    modal.querySelector('[data-action="review"]')?.addEventListener('click', () => {
      annotator.fitWidth();
      zoomLevel.value = `${Math.round(annotator.getZoom() * 100)}%`;
      modalElement.classList.add('bd-annotation--review');
      heading.textContent = t().reviewScreenshotTitle;
      nav.setAttribute('aria-label', t().reviewScreenshotTitle);
      modal.querySelector<HTMLElement>('[data-action="back-to-edit"]')?.focus();
    });
    modal.querySelector('[data-action="back-to-edit"]')?.addEventListener('click', () => {
      modalElement.classList.remove('bd-annotation--review');
      heading.textContent = t().editScreenshotTitle;
      nav.setAttribute('aria-label', t().editScreenshotTitle);
      modal.querySelector<HTMLElement>('[data-action="review"]')?.focus();
    });

    doneBtn?.addEventListener('click', () => {
      finish(annotator.getImageData());
    });
    modal.querySelector('[data-action="send-reviewed"]')?.addEventListener('click', () => {
      if (modalElement.classList.contains('bd-annotation--review')) {
        finish(annotator.getImageData());
      }
    });
  });
}

function wireAnnotationTools(modal: HTMLElement, annotator: ReturnType<typeof createAnnotator>) {
  const toolButtons = modal.querySelectorAll('[data-tool]');
  toolButtons.forEach(btn => {
    btn.addEventListener('click', event => {
      const target = event.currentTarget as HTMLElement;
      const tool = target.dataset.tool;
      if (!tool) return;
      toolButtons.forEach(button => {
        button.classList.remove('active');
        button.setAttribute('aria-pressed', 'false');
      });
      target.classList.add('active');
      target.setAttribute('aria-pressed', 'true');
      annotator.setTool(tool as Tool);
    });
  });
  modal.querySelector('[data-action="undo"]')?.addEventListener('click', () => annotator.undo());
}

function annotationContent(redactionNote: string, selectedElementNote: string): string {
  return `
        <nav class="bd-annotation-nav" aria-label="${escapeWidgetText(t().editScreenshotTitle)}">
          <button class="bd-btn bd-btn-secondary bd-annotation-retake" data-action="mobile-retake">← ${escapeWidgetText(t().retake)}</button>
          <button class="bd-btn bd-btn-secondary bd-annotation-back" data-action="back-to-edit">← ${escapeWidgetText(t().backToEdit)}</button>
          <button class="bd-btn bd-btn-primary bd-annotation-next" data-action="review">${escapeWidgetText(t().reviewButton)} →</button>
        </nav>
        <div class="bd-annotation-notes">
          ${redactionNote}
          <p class="bd-annotation-instruction">${escapeWidgetText(t().annotationInstruction)}</p>
          <p class="bd-annotation-review-instruction">${escapeWidgetText(t().reviewInstruction)}</p>
          ${selectedElementNote}
        </div>
        <div class="bd-tools">
          <button class="bd-tool active" data-tool="draw" aria-label="${escapeWidgetText(t().toolDraw)}" aria-pressed="true"><span class="bd-tool-icon" aria-hidden="true">✏️</span><span class="bd-tool-label">${escapeWidgetText(t().toolDraw)}</span></button>
          <button class="bd-tool" data-tool="arrow" aria-label="${escapeWidgetText(t().toolArrow)}" aria-pressed="false"><span class="bd-tool-icon" aria-hidden="true">➡️</span><span class="bd-tool-label">${escapeWidgetText(t().toolArrow)}</span></button>
          <button class="bd-tool" data-tool="rect" aria-label="${escapeWidgetText(t().toolRectangle)}" aria-pressed="false"><span class="bd-tool-icon" aria-hidden="true">▢</span><span class="bd-tool-label">${escapeWidgetText(t().toolRectangle)}</span></button>
          <button class="bd-tool" data-tool="redact" aria-label="${escapeWidgetText(t().toolRedact)}" aria-pressed="false"><span class="bd-tool-icon" aria-hidden="true">▨</span><span class="bd-tool-label">${escapeWidgetText(t().toolRedact)}</span></button>
          <button class="bd-tool" data-tool="pan" aria-label="${escapeWidgetText(t().toolPan)}" aria-pressed="false"><span class="bd-tool-icon" aria-hidden="true">✋</span><span class="bd-tool-label">${escapeWidgetText(t().toolPan)}</span></button>
          <button class="bd-tool" data-action="undo" aria-label="${escapeWidgetText(t().undo)}"><span class="bd-tool-icon" aria-hidden="true">↶</span><span class="bd-tool-label">${escapeWidgetText(t().undo)}</span></button>
        </div>
        <div class="bd-canvas-area">
          <div class="bd-view-controls">
            <button class="bd-tool" data-view="fit">${escapeWidgetText(t().fitWidth)}</button>
            <button class="bd-tool" data-view="out" aria-label="${escapeWidgetText(t().zoomOut)}">−</button>
            <output class="bd-zoom-level" aria-live="polite">100%</output>
            <button class="bd-tool" data-view="in" aria-label="${escapeWidgetText(t().zoomIn)}">+</button>
            <button class="bd-tool" data-view="reset">${escapeWidgetText(t().resetView)}</button>
          </div>
          <div id="annotation-canvas" class="bd-annotation-stage"></div>
        </div>
        <div class="bd-actions">
          <button class="bd-btn bd-btn-secondary" data-action="retake">${escapeWidgetText(t().retake)}</button>
          <button class="bd-btn bd-btn-primary" data-action="done">${escapeWidgetText(t().submitFeedback)}</button>
        </div>
        <div class="bd-annotation-send">
          <button class="bd-btn bd-btn-primary" data-action="send-reviewed">${escapeWidgetText(t().submitFeedback)}</button>
        </div>
        <div class="bd-retake-confirm" role="dialog" aria-modal="true" aria-labelledby="bd-retake-title" hidden>
          <div class="bd-retake-confirm-card">
            <h3 id="bd-retake-title">${escapeWidgetText(t().retakeConfirmTitle)}</h3>
            <p>${escapeWidgetText(t().retakeConfirmMessage)}</p>
            <button class="bd-btn bd-btn-secondary" data-action="keep-editing">${escapeWidgetText(t().keepEditing)}</button>
            <button class="bd-btn bd-btn-primary" data-action="confirm-retake">${escapeWidgetText(t().discardAndRetake)}</button>
          </div>
        </div>
  `;
}
