import type { SubmissionResult } from '../variants/public-types';
import type { FlowDefinition } from './definition';
import type { FlowRoute } from './runtime';
import type { ScreenshotScreen } from './public-types';

export function prepareDialog(surface: HTMLElement, instanceId: string, size: string): HTMLElement {
  const title = surface.querySelector<HTMLElement>('.bdv-title');
  const titleId = `${instanceId}-title`;
  if (title) title.id = titleId;
  surface.setAttribute('role', 'dialog');
  surface.setAttribute('aria-modal', 'true');
  surface.setAttribute('aria-labelledby', titleId);
  surface.tabIndex = -1;
  surface.dataset.size = size;
  return surface;
}

export function addNavigation(
  surface: HTMLElement,
  route: FlowRoute,
  onBack: () => void,
  onAdvance: () => void,
  onClose: () => void
): void {
  const screen = route.screen!;
  const close = button('×', 'bdv-close');
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', onClose, { once: true });
  surface.prepend(close);
  const progress = document.createElement('p');
  progress.className = 'bdf-progress';
  progress.textContent = `Step ${route.position} of ${route.total}`;
  surface.querySelector('.bdv-header')?.prepend(progress);
  const actions = document.createElement('div');
  actions.className = 'bdv-actions';
  if (route.canGoBack) {
    const back = button(
      screen.type === 'message' ? 'Back' : (screen.backLabel ?? 'Back'),
      'bdv-cancel bdf-back'
    );
    back.addEventListener('click', onBack);
    actions.appendChild(back);
  }
  const label = screen.continueLabel ?? (route.hasNext ? 'Continue' : 'Submit');
  const next = button(label, 'bdv-submit');
  next.addEventListener('click', onAdvance);
  actions.appendChild(next);
  surface.appendChild(actions);
}

export function createScreenshotPrompt(screen: Readonly<ScreenshotScreen>): HTMLElement {
  const surface = createStatusSurface(
    screen.title ?? 'Add a screenshot',
    screen.description ??
      (screen.mode === 'required'
        ? 'A screenshot is required before submitting.'
        : 'Include a screenshot to help explain your feedback.')
  );
  surface.classList.add('bdf-screenshot-prompt');
  if (screen.mode === 'optional') {
    const row = document.createElement('label');
    row.className = 'bdf-checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.dataset.screenshot = '';
    row.append(input, document.createTextNode('Include a screenshot'));
    surface.appendChild(row);
  }
  return surface;
}

export function createStatusSurface(titleText: string, message: string): HTMLElement {
  const surface = document.createElement('section');
  surface.className = 'bdv-surface';
  const header = document.createElement('div');
  header.className = 'bdv-header';
  const title = document.createElement('h2');
  title.className = 'bdv-title';
  title.textContent = titleText;
  const description = document.createElement('p');
  description.className = 'bdv-description';
  description.textContent = message;
  header.append(title, description);
  surface.appendChild(header);
  return surface;
}

export function createErrorSurface(
  message: string,
  cancelLabel: string,
  retry: () => void,
  close: () => void
): HTMLElement {
  const surface = createStatusSurface('Submission failed', message);
  const actions = document.createElement('div');
  actions.className = 'bdv-actions';
  const retryButton = button('Try again', 'bdv-submit');
  retryButton.addEventListener('click', retry);
  const cancel = button(cancelLabel, 'bdv-cancel');
  cancel.addEventListener('click', close);
  actions.append(retryButton, cancel);
  surface.appendChild(actions);
  return surface;
}

export function createSuccessSurface(
  definition: FlowDefinition,
  submission: SubmissionResult,
  close: () => void
): HTMLElement {
  const surface = createStatusSurface(
    definition.config.content?.successTitle ?? 'Thanks for your feedback!',
    definition.config.content?.successMessage ?? 'Your response was submitted.'
  );
  if (submission.isPublic) {
    const link = document.createElement('a');
    link.className = 'bdv-success-link';
    link.href = submission.issueUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View GitHub Issue';
    surface.appendChild(link);
  }
  const done = button('Done', 'bdv-submit');
  done.addEventListener('click', close);
  surface.appendChild(done);
  return surface;
}

export function firstFocusable(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    'input:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href]'
  );
}

export function deepActiveElement(): HTMLElement | null {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement)
    active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
}

export function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter(element => !element.hidden && !element.closest('[inert], [aria-hidden="true"]'));
}

function button(label: string, className: string): HTMLButtonElement {
  const value = document.createElement('button');
  value.type = 'button';
  value.className = className;
  value.textContent = label;
  return value;
}
