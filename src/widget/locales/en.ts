import type { WidgetStrings } from '../i18n';

export const en: WidgetStrings = {
  // Trigger button & pull tab
  triggerLabel: 'Feedback',
  triggerAriaLabel: 'Report a bug or send feedback',
  dismissButtonAriaLabel: 'Dismiss feedback button',
  pullTabAriaLabel: 'Show feedback button',
  dragHandleTitle: 'Drag feedback button',
  // Install prompt
  installRequiredTitle: 'Install Required',
  connectionErrorTitle: 'Connection Error',
  installRequiredMessage: 'BugDrop requires GitHub App installation to create issues.',
  apiUnreachableMessage:
    'Unable to reach BugDrop API. Check your network connection or script tag URL.',
  installApp: 'Install App',
  // Welcome screen
  welcomeTitle: 'Share Your Feedback',
  welcomeHeadline: 'Help us improve by sharing your thoughts',
  welcomeBodyLine1: 'Report bugs, suggest features, or leave feedback.',
  welcomeBodyLine2: 'You can optionally include annotated screenshots.',
  getStarted: 'Get Started',
  // Feedback form
  feedbackFormTitle: 'Send Feedback',
  categoryLabel: 'Category',
  categoryBug: 'Bug',
  categoryFeature: 'Feature',
  categoryQuestion: 'Question',
  nameLabel: 'Name',
  namePlaceholder: 'Your name',
  emailLabel: 'Email',
  emailPlaceholder: 'your@email.com',
  titleLabel: 'Title',
  titlePlaceholder: 'Brief description of the issue or suggestion',
  descriptionLabel: 'Description',
  descriptionPlaceholder: 'Provide additional details, steps to reproduce, or context...',
  screenshotAutoNote:
    'This site will attach a full-page screenshot when you submit without showing a preview. Review your page for sensitive information before sending.',
  screenshotAutoRedactionNote:
    'Some fields this site marked private may be visually masked on supported pages, but unmarked sensitive information can still be included.',
  screenshotRequiredNote: '📸 A screenshot is required before submitting.',
  includeScreenshotLabel: '📸 Include a screenshot',
  sendConsoleLogsLabel: 'Send Console Logs',
  // Uploads
  uploadsAriaLabel: 'Uploads',
  uploadFilesAriaLabel: 'Upload files',
  uploadButton: 'Upload',
  uploadTooMany: (max: number) => `Upload up to ${max} files. Remove a file before adding another.`,
  uploadUnsupportedType: 'That file type is not supported. Upload an image, PDF, or short video.',
  uploadTooLarge: (maxSize: string) => `File is too large. Upload files up to ${maxSize}.`,
  uploadReadError: 'Could not read that file. Try another one.',
  removeAttachmentAriaLabel: (name: string) => `Remove ${name}`,
  // Common buttons
  cancel: 'Cancel',
  continueButton: 'Continue',
  submit: 'Submit',
  // Submission
  submittingTitle: 'Submitting...',
  creatingIssue: 'Creating issue...',
  rateLimited: (minutes: number) =>
    `Too many submissions. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  submitFailedFallback: 'Failed to submit',
  networkError: 'Network error. Please check your connection.',
  submissionFailedTitle: 'Submission Failed',
  tryAgain: 'Try Again',
  // Success modal
  successTitle: 'Feedback Submitted!',
  issueCreated: (issueNumberHtml: string) => `Issue ${issueNumberHtml} has been created.`,
  feedbackSubmittedMessage: 'Your feedback has been submitted successfully.',
  viewOnGitHub: 'View on GitHub',
  done: 'Done',
  // Screenshot options
  captureScreenshotTitle: 'Capture Screenshot',
  chooseWhatToCapture: 'Choose what to capture:',
  viewportRedactionWarning:
    'Browser viewport capture cannot apply automatic private-field masks. Select Element to preserve automatic masking, or review and cover sensitive areas before sending.',
  redactionReviewNote:
    'This site marked some fields for redaction. Review the screenshot before sending.',
  pageTooComplexViewportNote:
    'This page is too complex for full-page or area capture. Capture the visible viewport or select a specific element instead.',
  pageTooComplexElementNote:
    'This page is too complex for full-page or area capture. Select a specific element instead.',
  fullPage: 'Full Page',
  viewportCaptureAlternative: 'Screenshot Issues? Capture Viewport instead',
  captureViewport: 'Capture Viewport',
  selectArea: 'Select Area',
  selectElement: 'Select Element',
  skipScreenshot: 'Skip Screenshot',
  // Element & area pickers
  areaPickerInstruction: 'Draw a selection around the area to capture',
  areaPickerRedactionInstruction:
    'Draw a selection around the area to capture. Marked private fields may be masked if included.',
  elementPickerInstruction: 'Click any element to capture it',
  elementPickerTouchInstruction: 'Tap any element to capture it',
  escToCancel: 'ESC to cancel',
  // Capture loading & failures
  capturingTitle: 'Capturing...',
  capturingScreenshot: 'Capturing screenshot...',
  captureFailedTitle: 'Capture Failed',
  captureFailedMessage:
    'Failed to capture screenshot. The page may be too complex or browser restrictions may apply.',
  chooseAnotherMethod: 'Choose Another Method',
  maskFailureTitle: 'Privacy masking failed',
  maskFailureMessage:
    'Automatic redaction of private fields could not be applied. To protect your data, this screenshot was discarded. You can still submit feedback without one.',
  continueWithoutScreenshot: 'Continue without screenshot',
  // Annotation step
  reviewScreenshotTitle: 'Review Screenshot',
  viewportRedactionUnavailableNote:
    'This browser viewport capture could not apply automatic private-field masks. Review and cover any sensitive areas before sending.',
  redactionCountNote: (count: number) =>
    `${count} private ${count === 1 ? 'item was' : 'items were'} marked for redaction in this screenshot. Review before sending.`,
  redactionLimitationsNote:
    'BugDrop only covered the measured marked boxes. It does not inspect pixels inside embedded or rendered content such as iframes, canvas, images, SVGs, videos, CSS backgrounds, or custom controls. Confirm the black box fully covers the sensitive region before sending, or retake after marking a larger wrapper.',
  annotationInstruction:
    'Check that no sensitive information is visible before sending. Cover sensitive areas before submitting. Redactions are baked into the uploaded image.',
  selectedElementNote: (linkHtml: string) =>
    `Need more surrounding context? Adjust ${linkHtml} on the BugDrop script tag.`,
  toolDraw: 'Draw',
  toolArrow: 'Arrow',
  toolRectangle: 'Rectangle',
  toolRedact: 'Redact',
  undo: 'Undo',
  retake: 'Retake',
  submitFeedback: 'Submit Feedback',
  // Capture timeout
  captureTimeout: 'Screenshot capture timed out — the page may be too complex',
};
