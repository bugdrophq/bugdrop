import { evaluateCondition } from './conditions';
import type { FlowDefinition } from './definition';
import type { FlowScalar, FlowScreen } from './public-types';

export interface CaptureEvidence {
  screenshot: string | null;
  elementSelector: string | null;
  fullElementSelector: string | null;
}

export interface FlowRoute {
  readonly screen: Readonly<FlowScreen> | undefined;
  readonly position: number;
  readonly total: number;
  readonly canGoBack: boolean;
  readonly hasNext: boolean;
}

export class FlowRuntime {
  readonly answers: Record<string, unknown>;
  capture: CaptureEvidence | null = null;
  private currentId: string;

  constructor(
    readonly definition: FlowDefinition,
    readonly context: Readonly<Record<string, FlowScalar>>,
    initialAnswers: Record<string, unknown> = {}
  ) {
    this.answers = { ...initialAnswers };
    this.reconcileInitiallyHidden();
    this.currentId = this.visibleScreens()[0]?.id ?? '';
  }

  current(): Readonly<FlowScreen> | undefined {
    return this.route().screen;
  }

  route(): FlowRoute {
    const visible = this.visibleScreens();
    const found = visible.findIndex(screen => screen.id === this.currentId);
    const index = found >= 0 ? found : 0;
    return Object.freeze({
      screen: visible[index],
      position: visible.length === 0 ? 0 : index + 1,
      total: visible.length,
      canGoBack: index > 0,
      hasNext: index >= 0 && index < visible.length - 1,
    });
  }

  setFormAnswers(formId: string, values: Record<string, unknown>): void {
    const previouslyVisible = new Set(this.visibleScreens().map(screen => screen.id));
    const paths = this.definition.screenAnswerPaths.get(
      this.definition.screens.find(screen => screen.type === 'form' && screen.form === formId)!.id
    )!;
    for (const path of paths) {
      const fieldId = path.slice(formId.length + 1);
      this.answers[path] = values[fieldId];
    }
    this.reconcileNewlyHidden(previouslyVisible);
  }

  next(): boolean {
    const route = this.route();
    const visible = this.visibleScreens();
    if (route.hasNext) {
      this.currentId = visible[route.position]!.id;
      return true;
    }
    return false;
  }

  back(): boolean {
    const route = this.route();
    const visible = this.visibleScreens();
    if (route.canGoBack) {
      this.currentId = visible[route.position - 2]!.id;
      return true;
    }
    return false;
  }

  hasNext(): boolean {
    return this.route().hasNext;
  }

  private visibleScreens(): readonly Readonly<FlowScreen>[] {
    return this.definition.screens.filter(screen =>
      evaluateCondition(screen.when, this.answers, this.context)
    );
  }

  private reconcileInitiallyHidden(): void {
    for (const screen of this.definition.screens) {
      if (evaluateCondition(screen.when, this.answers, this.context)) continue;
      this.clearScreenState(screen);
    }
  }

  private reconcileNewlyHidden(previouslyVisible: ReadonlySet<string>): void {
    let visible = new Set(this.visibleScreens().map(screen => screen.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const screen of this.definition.screens) {
        if (!previouslyVisible.has(screen.id) || visible.has(screen.id)) continue;
        changed = this.clearScreenState(screen) || changed;
      }
      if (changed) visible = new Set(this.visibleScreens().map(screen => screen.id));
    }
    if (!visible.has(this.currentId)) this.currentId = this.nearestVisibleId(visible);
  }

  private clearScreenState(screen: Readonly<FlowScreen>): boolean {
    let changed = false;
    for (const path of this.definition.screenAnswerPaths.get(screen.id) ?? []) {
      if (Object.prototype.hasOwnProperty.call(this.answers, path)) changed = true;
      delete this.answers[path];
    }
    if (screen.type === 'screenshot' && this.capture !== null) {
      this.capture = null;
      changed = true;
    }
    return changed;
  }

  private nearestVisibleId(visible: ReadonlySet<string>): string {
    const oldIndex = this.definition.screens.findIndex(screen => screen.id === this.currentId);
    for (let index = oldIndex; index >= 0; index -= 1) {
      const candidate = this.definition.screens[index];
      if (candidate && visible.has(candidate.id)) return candidate.id;
    }
    return this.visibleScreens()[0]?.id ?? '';
  }
}
