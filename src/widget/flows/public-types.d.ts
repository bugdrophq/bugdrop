import type {
  SubmissionResult,
  VariantContext,
  VariantField,
  VariantTheme,
} from '../variants/public-types';

export interface CheckboxField {
  id: string;
  type: 'checkbox';
  label: string;
  helpText?: string;
  required?: boolean;
  initialValue?: boolean;
  layout?: { span?: 1 | 2 };
}

export interface AttachmentsField {
  id: string;
  type: 'attachments';
  label: string;
  helpText?: string;
  required?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  accept?: string[];
  layout?: { span?: 1 | 2 };
}

export type FlowTextField = Extract<VariantField, { type: 'shortText' | 'longText' }> & {
  /** Per-open default, applied only when this field is shown and has no answer yet. */
  prefillFromContext?: string;
};
export type FlowField =
  | Exclude<VariantField, { type: 'shortText' | 'longText' }>
  | FlowTextField
  | CheckboxField
  | AttachmentsField;
export type FlowScalar = string | number | boolean | null;

export type FlowCondition =
  | { answer: string; equals: FlowScalar }
  | { context: string; equals: FlowScalar }
  | { all: FlowCondition[] }
  | { any: FlowCondition[] };

export interface FlowForm {
  id: string;
  title: string;
  description?: string;
  fields: FlowField[];
}

interface BaseScreen {
  id: string;
  when?: FlowCondition;
}

export interface MessageScreen extends BaseScreen {
  type: 'message';
  title: string;
  description?: string;
  continueLabel?: string;
}

export interface FormScreen extends BaseScreen {
  type: 'form';
  form: string;
  continueLabel?: string;
  backLabel?: string;
  /** Alternative final submit buttons. Metadata is mapped through Issue context sections. */
  submitActions?: FlowSubmitAction[];
  /** First nonempty earlier text answer to display as a plain-text quote. */
  quotePreview?: string[];
}

export interface FlowSubmitAction {
  label: string;
  metadata: Record<string, FlowScalar>;
}

export interface ScreenshotScreen extends BaseScreen {
  type: 'screenshot';
  title?: string;
  description?: string;
  mode: 'optional' | 'auto' | 'required';
  continueLabel?: string;
  backLabel?: string;
}

export type FlowScreen = MessageScreen | FormScreen | ScreenshotScreen;

export interface FlowScreenTransitionFrame {
  opacity?: number;
  translateX?: number;
  translateY?: number;
  scale?: number;
}

export interface FlowScreenTransitionMotion {
  enterFrom: FlowScreenTransitionFrame;
  exitTo: FlowScreenTransitionFrame;
}

export type FlowScreenTransition =
  | { kind: 'none' }
  | {
      kind: 'slide-horizontal' | 'slide-vertical' | 'fade' | 'scale-fade';
      durationMs?: number;
    }
  | {
      kind: 'custom';
      durationMs?: number;
      easing?: 'standard' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
      forward: FlowScreenTransitionMotion;
      backward: FlowScreenTransitionMotion;
    };

export type FlowIssueSection =
  | {
      heading: string;
      answer: string;
      format?: 'text' | 'quote' | 'stars' | 'choice' | 'code';
      omitWhenEmpty?: boolean;
      when?: FlowCondition;
    }
  | {
      heading: string;
      context: string;
      format?: 'text' | 'code';
      omitWhenEmpty?: boolean;
      when?: FlowCondition;
    };

export interface FlowConfig {
  configVersion: 1;
  id: string;
  presentation: {
    kind: 'modal';
    size?: 'compact' | 'default' | 'wide';
    columns?: 1 | 2;
    screenTransition?: FlowScreenTransition;
  };
  appearance?: {
    theme?: VariantTheme;
    accentColor?: string;
    density?: 'compact' | 'comfortable';
  };
  content?: {
    successTitle?: string;
    successMessage?: string;
    cancelLabel?: string;
  };
  forms: FlowForm[];
  screens: FlowScreen[];
  issue: {
    classification?: 'bug' | 'feature' | 'question';
    title: string;
    sections?: FlowIssueSection[];
  };
  evidence?: {
    attachments?: string;
    sendConsoleLogs?: string;
    submitter?: { name?: string; email?: string };
  };
}

export interface FlowOpenOptions {
  context?: VariantContext;
  initialAnswers?: Record<string, unknown>;
}

export type FlowOutcome =
  { status: 'submitted'; result: SubmissionResult } | { status: 'closed' } | { status: 'busy' };

export interface OpenedFlow {
  readonly instanceId: string;
  readonly result: Promise<FlowOutcome>;
  close(): void;
}

export interface FlowHandle {
  readonly id: string;
  open(options?: FlowOpenOptions): OpenedFlow;
}
