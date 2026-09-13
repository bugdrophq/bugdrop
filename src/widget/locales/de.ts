import type { WidgetStrings } from '../i18n';

export const de: WidgetStrings = {
  // Trigger button & pull tab
  triggerLabel: 'Feedback',
  triggerAriaLabel: 'Fehler melden oder Feedback senden',
  dismissButtonAriaLabel: 'Feedback-Button ausblenden',
  pullTabAriaLabel: 'Feedback-Button anzeigen',
  dragHandleTitle: 'Feedback-Button verschieben',
  // Install prompt
  installRequiredTitle: 'Installation erforderlich',
  connectionErrorTitle: 'Verbindungsfehler',
  installRequiredMessage:
    'BugDrop benötigt die Installation der GitHub-App, um Issues zu erstellen.',
  apiUnreachableMessage:
    'Die BugDrop-API ist nicht erreichbar. Überprüfen Sie Ihre Netzwerkverbindung oder die URL des Script-Tags.',
  installApp: 'App installieren',
  // Welcome screen
  welcomeTitle: 'Teilen Sie Ihr Feedback',
  welcomeHeadline: 'Helfen Sie uns, besser zu werden, indem Sie Ihre Meinung teilen',
  welcomeBodyLine1:
    'Melden Sie Fehler, schlagen Sie Funktionen vor oder hinterlassen Sie Feedback.',
  welcomeBodyLine2: 'Sie können optional kommentierte Screenshots hinzufügen.',
  getStarted: 'Los geht’s',
  // Feedback form
  feedbackFormTitle: 'Feedback senden',
  categoryLabel: 'Kategorie',
  categoryBug: 'Fehler',
  categoryFeature: 'Funktion',
  categoryQuestion: 'Frage',
  nameLabel: 'Name',
  namePlaceholder: 'Ihr Name',
  emailLabel: 'E-Mail',
  emailPlaceholder: 'ihre@email.de',
  titleLabel: 'Titel',
  titlePlaceholder: 'Kurze Beschreibung des Problems oder Vorschlags',
  descriptionLabel: 'Beschreibung',
  descriptionPlaceholder: 'Geben Sie weitere Details, Schritte zur Reproduktion oder Kontext an...',
  screenshotAutoNote:
    'Diese Website hängt beim Absenden automatisch einen Screenshot der gesamten Seite an, ohne eine Vorschau anzuzeigen. Überprüfen Sie Ihre Seite vor dem Senden auf sensible Informationen.',
  screenshotAutoRedactionNote:
    'Einige von dieser Website als privat markierte Felder können auf unterstützten Seiten optisch maskiert werden, nicht markierte sensible Informationen können jedoch weiterhin enthalten sein.',
  screenshotRequiredNote: '📸 Vor dem Absenden ist ein Screenshot erforderlich.',
  includeScreenshotLabel: '📸 Screenshot hinzufügen',
  sendConsoleLogsLabel: 'Konsolenprotokolle mitsenden',
  // Uploads
  uploadsAriaLabel: 'Uploads',
  uploadFilesAriaLabel: 'Dateien hochladen',
  uploadButton: 'Hochladen',
  uploadTooMany: (max: number) =>
    `Laden Sie bis zu ${max} Dateien hoch. Entfernen Sie eine Datei, bevor Sie eine weitere hinzufügen.`,
  uploadUnsupportedType:
    'Dieser Dateityp wird nicht unterstützt. Laden Sie ein Bild, ein PDF oder ein kurzes Video hoch.',
  uploadTooLarge: (maxSize: string) =>
    `Die Datei ist zu groß. Laden Sie Dateien bis zu ${maxSize} hoch.`,
  uploadReadError: 'Diese Datei konnte nicht gelesen werden. Versuchen Sie es mit einer anderen.',
  removeAttachmentAriaLabel: (name: string) => `${name} entfernen`,
  // Common buttons
  cancel: 'Abbrechen',
  continueButton: 'Weiter',
  submit: 'Absenden',
  // Submission
  submittingTitle: 'Wird gesendet...',
  creatingIssue: 'Issue wird erstellt...',
  rateLimited: (minutes: number) =>
    `Zu viele Übermittlungen. Bitte versuchen Sie es in ${minutes} Minute${minutes === 1 ? '' : 'n'} erneut.`,
  submitFailedFallback: 'Senden fehlgeschlagen',
  networkError: 'Netzwerkfehler. Bitte überprüfen Sie Ihre Verbindung.',
  submissionFailedTitle: 'Senden fehlgeschlagen',
  tryAgain: 'Erneut versuchen',
  // Success modal
  successTitle: 'Feedback gesendet!',
  issueCreated: (issueNumberHtml: string) => `Issue ${issueNumberHtml} wurde erstellt.`,
  feedbackSubmittedMessage: 'Ihr Feedback wurde erfolgreich gesendet.',
  viewOnGitHub: 'Auf GitHub ansehen',
  done: 'Fertig',
  // Screenshot options
  captureScreenshotTitle: 'Screenshot erstellen',
  chooseWhatToCapture: 'Wählen Sie aus, was erfasst werden soll:',
  viewportRedactionWarning:
    'Bei der Erfassung des sichtbaren Bereichs über den Browser können private Felder nicht automatisch maskiert werden. Wählen Sie „Element auswählen“, um die automatische Maskierung beizubehalten, oder überprüfen und verdecken Sie sensible Bereiche vor dem Senden.',
  redactionReviewNote:
    'Diese Website hat einige Felder zur Schwärzung markiert. Überprüfen Sie den Screenshot vor dem Senden.',
  pageTooComplexViewportNote:
    'Diese Seite ist zu komplex für eine vollständige Erfassung oder eine Bereichserfassung. Erfassen Sie stattdessen den sichtbaren Bereich oder wählen Sie ein bestimmtes Element aus.',
  pageTooComplexElementNote:
    'Diese Seite ist zu komplex für eine vollständige Erfassung oder eine Bereichserfassung. Wählen Sie stattdessen ein bestimmtes Element aus.',
  fullPage: 'Ganze Seite',
  viewportCaptureAlternative:
    'Probleme mit Screenshots? Stattdessen den sichtbaren Bereich aufnehmen',
  captureViewport: 'Sichtbaren Bereich erfassen',
  selectArea: 'Bereich auswählen',
  selectElement: 'Element auswählen',
  skipScreenshot: 'Screenshot überspringen',
  // Element & area pickers
  areaPickerInstruction: 'Ziehen Sie eine Auswahl um den zu erfassenden Bereich',
  areaPickerRedactionInstruction:
    'Ziehen Sie eine Auswahl um den zu erfassenden Bereich. Markierte private Felder können maskiert werden, wenn sie darin enthalten sind.',
  elementPickerInstruction: 'Klicken Sie auf ein beliebiges Element, um es zu erfassen',
  elementPickerTouchInstruction: 'Tippen Sie auf ein beliebiges Element, um es zu erfassen',
  escToCancel: 'ESC zum Abbrechen',
  // Capture loading & failures
  capturingTitle: 'Wird erfasst...',
  capturingScreenshot: 'Screenshot wird erfasst...',
  captureFailedTitle: 'Erfassung fehlgeschlagen',
  captureFailedMessage:
    'Der Screenshot konnte nicht erfasst werden. Die Seite ist möglicherweise zu komplex, oder Browsereinschränkungen greifen.',
  chooseAnotherMethod: 'Andere Methode wählen',
  maskFailureTitle: 'Datenschutz-Maskierung fehlgeschlagen',
  maskFailureMessage:
    'Die automatische Schwärzung privater Felder konnte nicht angewendet werden. Zum Schutz Ihrer Daten wurde dieser Screenshot verworfen. Sie können Ihr Feedback weiterhin ohne Screenshot senden.',
  continueWithoutScreenshot: 'Ohne Screenshot fortfahren',
  // Annotation step
  reviewScreenshotTitle: 'Screenshot überprüfen',
  viewportRedactionUnavailableNote:
    'Bei diesem über den Browser erfassten sichtbaren Bereich konnten private Felder nicht automatisch maskiert werden. Überprüfen und verdecken Sie sensible Bereiche vor dem Senden.',
  redactionCountNote: (count: number) =>
    count === 1
      ? `${count} privates Element wurde zur Schwärzung in diesem Screenshot markiert. Überprüfen Sie ihn vor dem Senden.`
      : `${count} private Elemente wurden zur Schwärzung in diesem Screenshot markiert. Überprüfen Sie ihn vor dem Senden.`,
  redactionLimitationsNote:
    'BugDrop hat nur die gemessenen markierten Bereiche abgedeckt. Es untersucht keine Pixel innerhalb eingebetteter oder gerenderter Inhalte wie iFrames, Canvas, Bildern, SVGs, Videos, CSS-Hintergründen oder benutzerdefinierten Steuerelementen. Stellen Sie vor dem Senden sicher, dass das schwarze Feld den sensiblen Bereich vollständig abdeckt, oder nehmen Sie den Screenshot nach Markierung eines größeren Bereichs erneut auf.',
  annotationInstruction:
    'Stellen Sie vor dem Senden sicher, dass keine sensiblen Informationen sichtbar sind. Verdecken Sie sensible Bereiche vor dem Absenden. Schwärzungen werden dauerhaft in das hochgeladene Bild eingebettet.',
  selectedElementNote: (linkHtml: string) =>
    `Benötigen Sie mehr umgebenden Kontext? Passen Sie ${linkHtml} im BugDrop-Script-Tag an.`,
  toolDraw: 'Zeichnen',
  toolArrow: 'Pfeil',
  toolRectangle: 'Rechteck',
  toolRedact: 'Schwärzen',
  undo: 'Rückgängig',
  retake: 'Erneut aufnehmen',
  submitFeedback: 'Feedback senden',
  // Capture timeout
  captureTimeout:
    'Zeitüberschreitung bei der Screenshot-Erfassung — die Seite ist möglicherweise zu komplex',
};
