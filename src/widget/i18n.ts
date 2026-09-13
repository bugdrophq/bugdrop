import { de } from './locales/de';
import { en } from './locales/en';
import { nl } from './locales/nl';
import { pl } from './locales/pl';
import { escapeHtml } from './sanitize';

export interface WidgetStrings {
  // Trigger button & pull tab
  triggerLabel: string;
  triggerAriaLabel: string;
  dismissButtonAriaLabel: string;
  pullTabAriaLabel: string;
  dragHandleTitle: string;
  // Install prompt
  installRequiredTitle: string;
  connectionErrorTitle: string;
  installRequiredMessage: string;
  apiUnreachableMessage: string;
  installApp: string;
  // Welcome screen
  welcomeTitle: string;
  welcomeHeadline: string;
  welcomeBodyLine1: string;
  welcomeBodyLine2: string;
  getStarted: string;
  // Feedback form
  feedbackFormTitle: string;
  categoryLabel: string;
  categoryBug: string;
  categoryFeature: string;
  categoryQuestion: string;
  nameLabel: string;
  namePlaceholder: string;
  emailLabel: string;
  emailPlaceholder: string;
  titleLabel: string;
  titlePlaceholder: string;
  descriptionLabel: string;
  descriptionPlaceholder: string;
  screenshotAutoNote: string;
  screenshotAutoRedactionNote: string;
  screenshotRequiredNote: string;
  includeScreenshotLabel: string;
  sendConsoleLogsLabel: string;
  // Uploads
  uploadsAriaLabel: string;
  uploadFilesAriaLabel: string;
  uploadButton: string;
  uploadTooMany: (max: number) => string;
  uploadUnsupportedType: string;
  uploadTooLarge: (maxSize: string) => string;
  uploadReadError: string;
  removeAttachmentAriaLabel: (name: string) => string;
  // Common buttons
  cancel: string;
  continueButton: string;
  submit: string;
  // Submission
  submittingTitle: string;
  creatingIssue: string;
  rateLimited: (minutes: number) => string;
  submitFailedFallback: string;
  networkError: string;
  submissionFailedTitle: string;
  tryAgain: string;
  // Success modal
  successTitle: string;
  // Callers pass a trusted issue-number HTML fragment; dictionaries own surrounding text only.
  issueCreated: (issueNumberHtml: string) => string;
  feedbackSubmittedMessage: string;
  viewOnGitHub: string;
  done: string;
  // Screenshot options
  captureScreenshotTitle: string;
  chooseWhatToCapture: string;
  viewportRedactionWarning: string;
  redactionReviewNote: string;
  pageTooComplexViewportNote: string;
  pageTooComplexElementNote: string;
  fullPage: string;
  captureViewport: string;
  viewportCaptureAlternative: string;
  selectArea: string;
  selectElement: string;
  skipScreenshot: string;
  // Element & area pickers
  areaPickerInstruction: string;
  areaPickerRedactionInstruction: string;
  elementPickerInstruction: string;
  elementPickerTouchInstruction: string;
  escToCancel: string;
  // Capture loading & failures
  capturingTitle: string;
  capturingScreenshot: string;
  captureFailedTitle: string;
  captureFailedMessage: string;
  chooseAnotherMethod: string;
  maskFailureTitle: string;
  maskFailureMessage: string;
  continueWithoutScreenshot: string;
  // Annotation step
  reviewScreenshotTitle: string;
  viewportRedactionUnavailableNote: string;
  redactionCountNote: (count: number) => string;
  redactionLimitationsNote: string;
  annotationInstruction: string;
  // Callers pass a trusted configuration-link HTML fragment; dictionaries own surrounding text only.
  selectedElementNote: (linkHtml: string) => string;
  toolDraw: string;
  toolArrow: string;
  toolRectangle: string;
  toolRedact: string;
  undo: string;
  retake: string;
  submitFeedback: string;
  // Capture timeout
  captureTimeout: string;
}

const DICTIONARIES = { en, de, nl, pl } satisfies Record<string, WidgetStrings>;

export type SupportedLocale = keyof typeof DICTIONARIES;

// Use this for dictionary strings inserted into raw HTML templates.
export function escapeWidgetText(value: string): string {
  return escapeHtml(value);
}

export function resolveLocale(raw: string | undefined | null): SupportedLocale {
  if (!raw) return 'en';
  // Accept both BCP 47 ("nl-NL") and POSIX/Symfony ("nl_NL") region formats.
  const base = raw.toLowerCase().split(/[-_]/)[0];
  if (Object.prototype.hasOwnProperty.call(DICTIONARIES, base)) return base as SupportedLocale;
  console.warn(`[BugDrop] Unsupported data-locale "${raw}"; falling back to English.`);
  return 'en';
}

// The widget is a per-page singleton, so module-level locale state is acceptable.
let currentStrings: WidgetStrings = en;

export function setLocale(locale: SupportedLocale): void {
  currentStrings = DICTIONARIES[locale];
}

export function t(): WidgetStrings {
  return currentStrings;
}
