/* eslint-disable max-lines */
import { createRuntimeId } from '../variants/form';
import { closeActiveVariantModal } from '../variants/modal-coordinator';
import type { SubmissionResult } from '../variants/public-types';
import type { FlowDefinition } from './definition';
import { normalizeFlowOpenOptions } from './field-validation';
import { createFlowFormScreen, type FlowFormController } from './form-screen';
import { createMessageScreen } from './message-screen';
import { createFlowModalState, type FlowModalState } from './modal-state';
import { releaseLegacyModalIsolationForFlow } from '../legacy-modal-accessibility';
import {
  addNavigation,
  createErrorSurface,
  createScreenshotPrompt,
  createStatusSurface,
  createSuccessSurface,
  deepActiveElement,
  firstFocusable,
  focusable,
  prepareDialog,
} from './modal-view';
import type { FlowOpenOptions, FlowOutcome, OpenedFlow, ScreenshotScreen } from './public-types';
import { FlowRuntime, type CaptureEvidence } from './runtime';
import {
  createFlowScreenTransition,
  type FlowScreenDirection,
  type FlowScreenTransitionController,
} from './screen-transition';
import { createStyledFlowRoot } from './styles';
export interface FlowModalPorts {
  preflight(): Promise<{ status: 'installed' | 'not_installed' | 'unreachable'; appName?: string }>;
  capture(
    screen: Readonly<ScreenshotScreen>,
    include: boolean,
    signal: AbortSignal
  ): Promise<CaptureEvidence & { returnToForm: boolean }>;
  submit(runtime: FlowRuntime): Promise<SubmissionResult>;
}
export function openFlowModal(
  definition: FlowDefinition,
  options: FlowOpenOptions | undefined,
  ports: FlowModalPorts
): OpenedFlow {
  const normalized = normalizeFlowOpenOptions(definition, options);
  closeActiveVariantModal();
  return new FlowModalController(definition, normalized, ports).open();
}
class FlowModalController {
  private readonly instanceId: string;
  private readonly previousFocus: HTMLElement | null;
  private readonly runtime: FlowRuntime;
  private readonly result: Promise<FlowOutcome>;
  private resolveOutcome!: (outcome: FlowOutcome) => void;
  private readonly state: FlowModalState;
  private readonly screenTransition: FlowScreenTransitionController;
  private currentForm: FlowFormController | null = null;
  private settled = false;
  private closed = false;
  private busy = false;
  private dialogVersion = 0;
  private routePreviewVersion = 0;
  private preflightVersion = 0;
  private captureAbortController: AbortController | null = null;

  constructor(
    private readonly definition: FlowDefinition,
    normalized: ReturnType<typeof normalizeFlowOpenOptions>,
    private readonly ports: FlowModalPorts
  ) {
    this.instanceId = createRuntimeId(definition.flowId);
    this.previousFocus = deepActiveElement();
    this.runtime = new FlowRuntime(definition, normalized.context, normalized.initialAnswers);
    this.result = new Promise(resolve => {
      this.resolveOutcome = resolve;
    });
    this.state = createFlowModalState(
      definition.flowId,
      this.instanceId,
      shadow => createStyledFlowRoot(shadow, definition.config),
      event => this.onKeydown(event),
      event => this.onBackdrop(event)
    );
    this.screenTransition = createFlowScreenTransition(
      this.state.overlay,
      definition.config.presentation.screenTransition
    );
  }

  open(): OpenedFlow {
    const opened = Object.freeze({
      instanceId: this.instanceId,
      result: this.result,
      close: () => this.close(),
    });
    this.state.activate(opened.close);
    const checking = createStatusSurface('Preparing feedback', 'Checking installation…');
    checking.setAttribute('aria-busy', 'true');
    this.show(checking);
    void this.preflight();
    return opened;
  }

  private async preflight(): Promise<void> {
    const version = ++this.preflightVersion;
    try {
      const preflight = await this.ports.preflight();
      if (this.closed || version !== this.preflightVersion) return;
      if (preflight.status === 'installed') this.render();
      else {
        const message =
          preflight.status === 'not_installed'
            ? `Install the ${preflight.appName ?? 'BugDrop'} GitHub App to continue.`
            : 'BugDrop could not reach the feedback service.';
        this.renderError(message, () => void this.preflight());
      }
    } catch {
      if (!this.closed && version === this.preflightVersion)
        this.renderError(
          'BugDrop could not reach the feedback service.',
          () => void this.preflight()
        );
    }
  }

  private render(direction?: FlowScreenDirection): void {
    this.disposeForm();
    const route = this.runtime.route();
    const screen = route.screen;
    if (!screen) {
      void this.finish();
      return;
    }
    let surface: HTMLElement;
    if (screen.type === 'message') surface = createMessageScreen(screen);
    else if (screen.type === 'form') {
      const form = this.definition.config.forms.find(candidate => candidate.id === screen.form)!;
      this.currentForm = createFlowFormScreen(
        form,
        this.instanceId,
        this.runtime.answers,
        this.definition.config.evidence?.submitter
      );
      surface = this.currentForm.element;
    } else surface = createScreenshotPrompt(screen);
    addNavigation(
      surface,
      route,
      () => void this.back(screen),
      () => void this.advance(screen, surface),
      () => this.close()
    );
    if (screen.type === 'form') {
      const preview = () => void this.previewFormRoute(screen.form, surface);
      surface.addEventListener('input', preview);
      surface.addEventListener('change', preview);
    }
    this.show(surface, direction);
  }

  private async previewFormRoute(formId: string, surface: HTMLElement): Promise<void> {
    const version = ++this.routePreviewVersion;
    const values = await this.currentForm?.snapshot();
    if (!values || version !== this.routePreviewVersion || !surface.isConnected || this.closed)
      return;
    this.runtime.setFormAnswers(formId, values);
    const route = this.runtime.route();
    const screen = route.screen;
    if (!screen) return;
    const progress = surface.querySelector<HTMLElement>('.bdf-progress');
    if (progress) progress.textContent = `Step ${route.position} of ${route.total}`;
    const next = surface.querySelector<HTMLButtonElement>('.bdv-submit');
    if (next) next.textContent = screen.continueLabel ?? (route.hasNext ? 'Continue' : 'Submit');
  }

  private async back(screen: NonNullable<ReturnType<FlowRuntime['current']>>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (screen.type === 'form') {
      const values = await this.currentForm?.snapshot();
      if (values === null || this.closed) {
        this.busy = false;
        return;
      }
      if (values) this.runtime.setFormAnswers(screen.form, values);
    }
    this.runtime.back();
    this.busy = false;
    this.render('backward');
  }

  private async advance(
    screen: NonNullable<ReturnType<FlowRuntime['current']>>,
    surface: HTMLElement
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (screen.type === 'form') {
      const values = await this.currentForm?.collect();
      if (!values || this.closed) {
        this.busy = false;
        return;
      }
      this.runtime.setFormAnswers(screen.form, values);
    }
    if (screen.type === 'screenshot') {
      this.busy = false;
      await this.capture(screen, surface);
      return;
    }
    if (!this.runtime.next()) {
      this.busy = false;
      await this.finish();
    } else {
      this.busy = false;
      this.render('forward');
    }
  }

  private async capture(screen: Readonly<ScreenshotScreen>, surface: HTMLElement): Promise<void> {
    const include =
      screen.mode !== 'optional' ||
      Boolean(surface.querySelector<HTMLInputElement>('[data-screenshot]')?.checked);
    this.busy = true;
    this.state.host.hidden = true;
    const abortController = new AbortController();
    this.captureAbortController = abortController;
    let direction: FlowScreenDirection;
    try {
      const capture = await this.ports.capture(screen, include, abortController.signal);
      releaseLegacyModalIsolationForFlow();
      if (this.closed) return;
      direction = capture.returnToForm ? 'backward' : 'forward';
      if (capture.returnToForm) this.runtime.back();
      else {
        this.runtime.capture = capture;
        if (!this.runtime.next()) {
          this.busy = false;
          await this.finish();
          return;
        }
      }
    } finally {
      if (this.captureAbortController === abortController) this.captureAbortController = null;
      this.busy = false;
      this.state.host.hidden = false;
    }
    if (!this.closed) this.render(direction);
  }

  private async finish(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    const status = createStatusSurface('Submitting feedback', 'Submitting…');
    status.setAttribute('aria-busy', 'true');
    this.show(status);
    try {
      const submission = await this.ports.submit(this.runtime);
      if (this.closed) return;
      this.settle({ status: 'submitted', result: submission });
      this.busy = false;
      this.show(createSuccessSurface(this.definition, submission, () => this.close(false)));
    } catch (error) {
      if (this.closed) return;
      this.busy = false;
      this.renderError(
        error instanceof Error ? error.message : 'Failed to submit feedback',
        () => void this.finish()
      );
    }
  }

  private renderError(message: string, retry: () => void): void {
    this.show(
      createErrorSurface(
        message,
        this.definition.config.content?.cancelLabel ?? 'Cancel',
        retry,
        () => this.close()
      )
    );
  }

  private show(surface: HTMLElement, direction?: FlowScreenDirection): void {
    prepareDialog(
      surface,
      `${this.instanceId}-surface-${++this.dialogVersion}`,
      this.definition.config.presentation.size ?? 'default'
    );
    this.screenTransition.show(surface, direction);
    queueMicrotask(() => (firstFocusable(surface) ?? surface).focus());
  }

  private close(settleClosed = true): void {
    if (this.closed) return;
    this.closed = true;
    this.preflightVersion += 1;
    this.captureAbortController?.abort();
    this.captureAbortController = null;
    releaseLegacyModalIsolationForFlow();
    if (settleClosed) this.settle({ status: 'closed' });
    this.disposeForm();
    this.screenTransition.dispose();
    this.state.dispose();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }

  private settle(outcome: FlowOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveOutcome(outcome);
  }

  private disposeForm(): void {
    this.routePreviewVersion += 1;
    this.currentForm?.dispose();
    this.currentForm = null;
  }

  private onKeydown(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = focusable(this.state.overlay);
    if (!elements.length) {
      event.preventDefault();
      this.state.overlay.querySelector<HTMLElement>('[role="dialog"]')?.focus();
      return;
    }
    const first = elements[0]!;
    const last = elements.at(-1)!;
    const active = this.state.shadow.activeElement;
    if (event.shiftKey && (active === first || !this.state.overlay.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private onBackdrop(event: PointerEvent): void {
    if (event.target === this.state.overlay) this.close();
  }
}
