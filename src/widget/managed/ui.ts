import { createManagedController } from './controller';
import type { RecoveryGuard } from './recovery';
import { managedMarkup } from './styles';
import type { Feedback, Outcome } from './protocol';

type ManagedFeedback = Feedback;
type ManagedOutcome = Outcome;

interface PreparedSubmission {
  submit(): Promise<ManagedOutcome>;
}

export interface ManagedWidgetAPI {
  open(): void;
  close(): void;
  hide(): void;
  show(): void;
  isOpen(): boolean;
  isButtonVisible(): boolean;
  setTheme(theme: 'light' | 'dark' | 'auto'): void;
}

export interface ManagedUIOptions {
  theme: 'light' | 'dark' | 'auto';
  position: 'bottom-right' | 'bottom-left';
  buttonVisible: boolean;
  guard?: RecoveryGuard;
  createSubmission(feedback: ManagedFeedback): Promise<PreparedSubmission>;
}

const encoder = new TextEncoder();
const editableCodes = new Set(['invalid_request', 'forbidden', 'payload_too_large']);
// Each manual retry obtains a fresh capability; expired or spent tokens can be replaced.
const retryableCodes = new Set([
  'invalid_capability',
  'replay_detected',
  'rate_limited',
  'authority_unavailable',
  'delivery_unavailable',
  'internal_error',
]);

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error('Managed widget failed to initialize');
  return element;
}

function hasForbiddenControls(value: string, allowLines: boolean): boolean {
  for (const symbol of value) {
    const point = symbol.codePointAt(0) ?? 0;
    if (point === 127 || (point >= 0xd800 && point <= 0xdfff)) return true;
    if (point < 32 && (!allowLines || (point !== 9 && point !== 10 && point !== 13))) return true;
  }
  return false;
}

function validateFields(title: string, description: string): string | null {
  if (!title.trim()) return 'Enter a title.';
  if (hasForbiddenControls(title, false) || encoder.encode(title).byteLength > 256)
    return 'Title must be at most 256 UTF-8 bytes without control characters.';
  if (!description.trim()) return 'Enter a description.';
  if (hasForbiddenControls(description, true) || encoder.encode(description).byteLength > 16_384)
    return 'Description must be at most 16,384 UTF-8 bytes of text.';
  return null;
}

function feedbackFrom(form: HTMLFormElement): ManagedFeedback | string {
  const title = required<HTMLInputElement>(form, 'input[name="title"]').value;
  const description = required<HTMLTextAreaElement>(form, 'textarea[name="description"]').value;
  const category = required<HTMLSelectElement>(form, 'select[name="category"]').value;
  const error = validateFields(title, description);
  if (error) return error;
  if (category && category !== 'bug' && category !== 'feature' && category !== 'question')
    return 'Select a valid category.';
  return Object.freeze({
    schemaVersion: 1,
    title,
    description,
    ...(category ? { category: category as 'bug' | 'feature' | 'question' } : {}),
  });
}

function statusText(
  phase: ManagedOutcome['status'] | 'submitting',
  hasSubmission: boolean,
  code?: string
): string {
  if (phase === 'submitting') return 'Sending feedback. You can return to this window later.';
  if (phase === 'delivered') return 'Feedback delivered.';
  if (phase === 'indeterminate')
    return hasSubmission
      ? 'Delivery could not be confirmed. Do not send a new report. Use Check result.'
      : 'Delivery could not be confirmed. Contact the site owner before sending another report.';
  if (phase === 'authorization_failed') return 'Unable to authorize. Try again.';
  if (retryableCodes.has(code ?? ''))
    return 'Delivery was not confirmed. Try again with this report.';
  return code === 'forbidden'
    ? 'Feedback was rejected. Ask the site owner to restore access. Your draft is available to edit.'
    : 'Feedback was rejected. Edit your draft before trying again.';
}

/** Isolated managed UI; its prepared submission is reused after an uncertain result. */
export function createManagedUI(host: HTMLElement, options: ManagedUIOptions): ManagedWidgetAPI {
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = managedMarkup;
  const root = required<HTMLElement>(shadow, '.root');
  const launcher = required<HTMLButtonElement>(shadow, '[data-action="open"]');
  const backdrop = required<HTMLElement>(shadow, '.backdrop');
  const form = required<HTMLFormElement>(shadow, '[data-role="feedback"]');
  const titleInput = required<HTMLInputElement>(form, 'input[name="title"]');
  const error = required<HTMLElement>(shadow, '[data-role="error"]');
  const result = required<HTMLElement>(shadow, '[data-role="result"]');
  const status = required<HTMLElement>(shadow, '[data-role="status"]');
  const receipt = required<HTMLElement>(shadow, '[data-role="receipt"]');
  const checkButton = required<HTMLButtonElement>(shadow, '[data-action="check-result"]');
  const newReportButton = required<HTMLButtonElement>(shadow, '[data-action="new-report"]');
  let recoveryBlocked = options.guard?.isBlocked() ?? false;
  let phase: 'draft' | 'submitting' | ManagedOutcome['status'] = recoveryBlocked
    ? 'indeterminate'
    : 'draft';
  let submission: PreparedSubmission | undefined;
  let hadUncertainResult = false;
  let lastCode: string | undefined;

  function render(): void {
    form.hidden = phase !== 'draft';
    result.hidden = phase === 'draft';
    if (phase !== 'draft')
      status.textContent = recoveryBlocked
        ? 'Feedback is locked because an earlier report may be unresolved or recovery storage is unavailable. Contact the site owner before sending another report.'
        : statusText(phase, !!submission, lastCode);
    const retryable =
      phase === 'authorization_failed' ||
      (phase === 'rejected' && retryableCodes.has(lastCode ?? ''));
    checkButton.hidden = !submission || (phase !== 'indeterminate' && !retryable);
    checkButton.textContent = phase === 'indeterminate' ? 'Check result' : 'Try again';
    const editable = phase === 'rejected' && editableCodes.has(lastCode ?? '');
    newReportButton.hidden = phase !== 'delivered' && !editable;
    newReportButton.textContent = editable ? 'Edit feedback' : 'Send another report';
    if (!backdrop.hidden && phase !== 'draft') status.focus();
  }

  async function runSubmission(): Promise<void> {
    if (!submission) return;
    if (options.guard && !(await options.guard.acquire())) {
      recoveryBlocked = true;
      submission = undefined;
      phase = 'indeterminate';
      render();
      return;
    }
    try {
      const outcome = await submission.submit();
      lastCode = outcome.status === 'rejected' ? outcome.code : undefined;
      if (outcome.status === 'indeterminate') hadUncertainResult = true;
      phase =
        hadUncertainResult && outcome.status !== 'delivered' ? 'indeterminate' : outcome.status;
      if (
        outcome.status === 'delivered' ||
        (outcome.status === 'rejected' && editableCodes.has(outcome.code) && !hadUncertainResult)
      )
        await options.guard?.release();
      if ('receiptId' in outcome && outcome.receiptId)
        receipt.textContent = `Receipt: ${outcome.receiptId}`;
    } catch {
      hadUncertainResult = true;
      phase = 'indeterminate';
    }
    render();
  }

  async function submitFresh(feedback: ManagedFeedback): Promise<void> {
    phase = 'submitting';
    render();
    try {
      submission = await options.createSubmission(feedback);
      await runSubmission();
    } catch {
      // Preparation has no network effect, so the draft can still be corrected.
      phase = 'draft';
      submission = undefined;
      error.textContent = 'Unable to prepare feedback. Check the fields and try again.';
      error.hidden = false;
      render();
    }
  }

  const api = createManagedController(shadow, () => phase === 'draft');

  root.dataset.theme = options.theme;
  root.dataset.position = options.position;
  launcher.hidden = !options.buttonVisible;
  for (const field of Array.from(form.querySelectorAll('input, textarea, select'))) {
    field.addEventListener('input', () => {
      if (phase === 'draft') {
        error.hidden = true;
        error.textContent = '';
      }
    });
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (phase !== 'draft') return;
    const feedback = feedbackFrom(form);
    if (typeof feedback === 'string') {
      error.textContent = feedback;
      error.hidden = false;
      return;
    }
    void submitFresh(feedback);
  });
  checkButton.addEventListener('click', () => {
    const retryable =
      phase === 'authorization_failed' ||
      (phase === 'rejected' && retryableCodes.has(lastCode ?? ''));
    if ((phase !== 'indeterminate' && !retryable) || !submission) return;
    phase = 'submitting';
    render();
    void runSubmission();
  });
  newReportButton.addEventListener('click', () => {
    const editable = phase === 'rejected' && editableCodes.has(lastCode ?? '');
    if (phase !== 'delivered' && !editable) return;
    if (options.guard?.isBlocked()) {
      recoveryBlocked = true;
      submission = undefined;
      phase = 'indeterminate';
      render();
      return;
    }
    if (!editable) form.reset();
    submission = undefined;
    hadUncertainResult = false;
    lastCode = undefined;
    receipt.textContent = '';
    error.textContent = '';
    error.hidden = true;
    phase = 'draft';
    render();
    titleInput.focus();
  });
  render();
  return api;
}
