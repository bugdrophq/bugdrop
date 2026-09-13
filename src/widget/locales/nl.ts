import type { WidgetStrings } from '../i18n';

export const nl: WidgetStrings = {
  // Trigger button & pull tab
  triggerLabel: 'Feedback',
  triggerAriaLabel: 'Een fout melden of feedback versturen',
  dismissButtonAriaLabel: 'Feedbackknop verbergen',
  pullTabAriaLabel: 'Feedbackknop tonen',
  dragHandleTitle: 'Feedbackknop verslepen',
  // Install prompt
  installRequiredTitle: 'Installatie vereist',
  connectionErrorTitle: 'Verbindingsfout',
  installRequiredMessage:
    'BugDrop vereist installatie van de GitHub-app om issues te kunnen aanmaken.',
  apiUnreachableMessage:
    'Kan de BugDrop-API niet bereiken. Controleer uw netwerkverbinding of de URL van de scripttag.',
  installApp: 'App installeren',
  // Welcome screen
  welcomeTitle: 'Deel uw feedback',
  welcomeHeadline: 'Help ons verbeteren door uw mening te delen',
  welcomeBodyLine1: 'Meld fouten, stel functies voor of laat feedback achter.',
  welcomeBodyLine2: 'U kunt optioneel schermafbeeldingen met aantekeningen toevoegen.',
  getStarted: 'Aan de slag',
  // Feedback form
  feedbackFormTitle: 'Feedback versturen',
  categoryLabel: 'Categorie',
  categoryBug: 'Fout',
  categoryFeature: 'Suggestie',
  categoryQuestion: 'Vraag',
  nameLabel: 'Naam',
  namePlaceholder: 'Uw naam',
  emailLabel: 'E-mail',
  emailPlaceholder: 'uw@email.nl',
  titleLabel: 'Titel',
  titlePlaceholder: 'Korte omschrijving van het probleem of de suggestie',
  descriptionLabel: 'Omschrijving',
  descriptionPlaceholder: 'Geef extra details, stappen om het te reproduceren of context...',
  screenshotAutoNote:
    'Deze site voegt bij het versturen automatisch een schermafbeelding van de volledige pagina toe, zonder voorbeeld. Controleer uw pagina op gevoelige informatie voordat u verstuurt.',
  screenshotAutoRedactionNote:
    'Sommige velden die deze site als privé heeft gemarkeerd, kunnen op ondersteunde pagina’s visueel worden gemaskeerd, maar niet-gemarkeerde gevoelige informatie kan nog steeds worden meegestuurd.',
  screenshotRequiredNote: '📸 Een schermafbeelding is vereist voordat u kunt versturen.',
  includeScreenshotLabel: '📸 Schermafbeelding toevoegen',
  sendConsoleLogsLabel: 'Consolelogboeken meesturen',
  // Uploads
  uploadsAriaLabel: 'Uploads',
  uploadFilesAriaLabel: 'Bestanden uploaden',
  uploadButton: 'Uploaden',
  uploadTooMany: (max: number) =>
    `Upload maximaal ${max} bestanden. Verwijder een bestand voordat u er een toevoegt.`,
  uploadUnsupportedType:
    'Dat bestandstype wordt niet ondersteund. Upload een afbeelding, pdf of korte video.',
  uploadTooLarge: (maxSize: string) => `Het bestand is te groot. Upload bestanden tot ${maxSize}.`,
  uploadReadError: 'Kan dat bestand niet lezen. Probeer een ander bestand.',
  removeAttachmentAriaLabel: (name: string) => `${name} verwijderen`,
  // Common buttons
  cancel: 'Annuleren',
  continueButton: 'Doorgaan',
  submit: 'Versturen',
  // Submission
  submittingTitle: 'Versturen...',
  creatingIssue: 'Issue aanmaken...',
  rateLimited: (minutes: number) =>
    `Te veel inzendingen. Probeer het over ${minutes} ${minutes === 1 ? 'minuut' : 'minuten'} opnieuw.`,
  submitFailedFallback: 'Versturen mislukt',
  networkError: 'Netwerkfout. Controleer uw verbinding.',
  submissionFailedTitle: 'Versturen mislukt',
  tryAgain: 'Opnieuw proberen',
  // Success modal
  successTitle: 'Feedback verstuurd!',
  issueCreated: (issueNumberHtml: string) => `Issue ${issueNumberHtml} is aangemaakt.`,
  feedbackSubmittedMessage: 'Uw feedback is succesvol verstuurd.',
  viewOnGitHub: 'Bekijken op GitHub',
  done: 'Klaar',
  // Screenshot options
  captureScreenshotTitle: 'Schermafbeelding maken',
  chooseWhatToCapture: 'Kies wat u wilt vastleggen:',
  viewportRedactionWarning:
    'Bij het vastleggen van het zichtbare deel via de browser kunnen privévelden niet automatisch worden gemaskeerd. Kies “Element selecteren” om automatische maskering te behouden, of controleer en dek gevoelige gebieden af voordat u verstuurt.',
  redactionReviewNote:
    'Deze site heeft enkele velden gemarkeerd voor redactie. Controleer de schermafbeelding voordat u verstuurt.',
  pageTooComplexViewportNote:
    'Deze pagina is te complex om volledig of per gebied vast te leggen. Leg het zichtbare deel vast of selecteer een specifiek element.',
  pageTooComplexElementNote:
    'Deze pagina is te complex om volledig of per gebied vast te leggen. Selecteer in plaats daarvan een specifiek element.',
  fullPage: 'Volledige pagina',
  viewportCaptureAlternative:
    'Problemen met screenshots? Leg in plaats daarvan het zichtbare gebied vast',
  captureViewport: 'Zichtbaar deel vastleggen',
  selectArea: 'Gebied selecteren',
  selectElement: 'Element selecteren',
  skipScreenshot: 'Schermafbeelding overslaan',
  // Element & area pickers
  areaPickerInstruction: 'Trek een selectie rond het gebied dat u wilt vastleggen',
  areaPickerRedactionInstruction:
    'Trek een selectie rond het gebied dat u wilt vastleggen. Gemarkeerde privévelden kunnen worden gemaskeerd als ze binnen de selectie vallen.',
  elementPickerInstruction: 'Klik op een element om het vast te leggen',
  elementPickerTouchInstruction: 'Tik op een element om het vast te leggen',
  escToCancel: 'ESC om te annuleren',
  // Capture loading & failures
  capturingTitle: 'Vastleggen...',
  capturingScreenshot: 'Schermafbeelding wordt gemaakt...',
  captureFailedTitle: 'Opname mislukt',
  captureFailedMessage:
    'Kan geen schermafbeelding maken. De pagina is mogelijk te complex of de browser staat dit niet toe.',
  chooseAnotherMethod: 'Kies een andere methode',
  maskFailureTitle: 'Privacymaskering mislukt',
  maskFailureMessage:
    'Automatische redactie van privévelden kon niet worden toegepast. Om uw gegevens te beschermen is deze schermafbeelding verwijderd. U kunt uw feedback nog steeds zonder schermafbeelding versturen.',
  continueWithoutScreenshot: 'Doorgaan zonder schermafbeelding',
  // Annotation step
  reviewScreenshotTitle: 'Schermafbeelding controleren',
  viewportRedactionUnavailableNote:
    'Bij deze via de browser vastgelegde schermafbeelding konden privévelden niet automatisch worden gemaskeerd. Controleer en dek gevoelige gebieden af voordat u verstuurt.',
  redactionCountNote: (count: number) =>
    count === 1
      ? '1 privé-item is gemarkeerd voor redactie in deze schermafbeelding. Controleer voordat u verstuurt.'
      : `${count} privé-items zijn gemarkeerd voor redactie in deze schermafbeelding. Controleer voordat u verstuurt.`,
  redactionLimitationsNote:
    'BugDrop heeft alleen de gemeten gemarkeerde vakken afgedekt. Het inspecteert geen pixels binnen ingesloten of gerenderde inhoud zoals iframes, canvas, afbeeldingen, SVG’s, video’s, CSS-achtergronden of aangepaste elementen. Controleer of het zwarte vak het gevoelige gebied volledig bedekt voordat u verstuurt, of maak de afbeelding opnieuw nadat u een groter element hebt gemarkeerd.',
  annotationInstruction:
    'Controleer of er geen gevoelige informatie zichtbaar is voordat u verstuurt. Dek gevoelige gebieden af voordat u indient. Redacties worden permanent in de geüploade afbeelding verwerkt.',
  selectedElementNote: (linkHtml: string) =>
    `Meer omringende context nodig? Pas ${linkHtml} aan op de BugDrop-scripttag.`,
  toolDraw: 'Tekenen',
  toolArrow: 'Pijl',
  toolRectangle: 'Rechthoek',
  toolRedact: 'Redigeren',
  undo: 'Ongedaan maken',
  retake: 'Opnieuw maken',
  submitFeedback: 'Feedback versturen',
  // Capture timeout
  captureTimeout:
    'Het maken van de schermafbeelding duurde te lang — de pagina is mogelijk te complex',
};
