import type { WidgetStrings } from '../i18n';

// Czech has three integer forms: 1, 2-4, and everything else (so 22 takes the "many" form).
function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  return count >= 2 && count <= 4 ? few : many;
}

export const cs: WidgetStrings = {
  // Trigger button & pull tab
  triggerLabel: 'Zpětná vazba',
  triggerAriaLabel: 'Nahlásit chybu nebo odeslat zpětnou vazbu',
  dismissButtonAriaLabel: 'Skrýt tlačítko zpětné vazby',
  pullTabAriaLabel: 'Zobrazit tlačítko zpětné vazby',
  dragHandleTitle: 'Přesunout tlačítko zpětné vazby',
  // Install prompt
  installRequiredTitle: 'Je nutná instalace',
  connectionErrorTitle: 'Chyba připojení',
  installRequiredMessage: 'BugDrop potřebuje k vytváření issues nainstalovanou aplikaci GitHub.',
  apiUnreachableMessage:
    'Nelze se připojit k API BugDrop. Zkontrolujte připojení k síti nebo adresu URL ve značce skriptu.',
  installApp: 'Nainstalovat aplikaci',
  // Welcome screen
  welcomeTitle: 'Podělte se o zpětnou vazbu',
  welcomeHeadline: 'Pomozte nám se zlepšovat a napište nám svůj názor',
  welcomeBodyLine1: 'Nahlaste chybu, navrhněte funkci nebo zanechte zpětnou vazbu.',
  welcomeBodyLine2: 'Můžete přiložit i snímky obrazovky s poznámkami.',
  getStarted: 'Začít',
  // Feedback form
  feedbackFormTitle: 'Odeslat zpětnou vazbu',
  categoryLabel: 'Kategorie',
  categoryBug: 'Chyba',
  categoryFeature: 'Návrh',
  categoryQuestion: 'Dotaz',
  nameLabel: 'Jméno',
  namePlaceholder: 'Vaše jméno',
  emailLabel: 'E-mail',
  emailPlaceholder: 'vas@email.cz',
  prefilledEmailDisclosure:
    'Pokud zde tento e-mail ponecháte, bude uveden v GitHub issue. Můžete ho upravit nebo smazat.',
  titleLabel: 'Název',
  titlePlaceholder: 'Stručný popis problému nebo návrhu',
  descriptionLabel: 'Popis',
  descriptionPlaceholder: 'Uveďte další podrobnosti, postup k zopakování nebo souvislosti...',
  screenshotAutoNote:
    'Tento web při odeslání přiloží snímek celé stránky bez zobrazení náhledu. Před odesláním zkontrolujte, zda stránka neobsahuje citlivé údaje.',
  screenshotAutoRedactionNote:
    'Některá pole, která tento web označil jako soukromá, mohou být na podporovaných stránkách vizuálně zakryta, neoznačené citlivé údaje však mohou být na snímku vidět.',
  screenshotRequiredNote: '📸 Před odesláním je nutné přiložit snímek obrazovky.',
  includeScreenshotLabel: '📸 Přiložit snímek obrazovky',
  sendConsoleLogsLabel: 'Odeslat protokoly konzole',
  // Uploads
  uploadsAriaLabel: 'Přílohy',
  uploadFilesAriaLabel: 'Nahrát soubory',
  uploadButton: 'Nahrát',
  uploadTooMany: (max: number) =>
    `Před přidáním dalšího souboru některý odeberte. Nahrát lze nejvýše ${max} ${plural(max, 'soubor', 'soubory', 'souborů')}.`,
  uploadUnsupportedType:
    'Tento typ souboru není podporován. Nahrajte obrázek, PDF nebo krátké video.',
  uploadTooLarge: (maxSize: string) =>
    `Soubor je příliš velký. Nahrát lze soubory o velikosti nejvýše ${maxSize}.`,
  uploadReadError: 'Soubor se nepodařilo načíst. Zkuste jiný.',
  removeAttachmentAriaLabel: (name: string) => `Odebrat ${name}`,
  // Common buttons
  closeDialog: 'Zavřít',
  cancel: 'Zrušit',
  continueButton: 'Pokračovat',
  submit: 'Odeslat',
  // Submission
  submittingTitle: 'Odesílání...',
  creatingIssue: 'Vytváření issue...',
  rateLimited: (minutes: number) =>
    `Příliš mnoho odeslání. Zkuste to prosím znovu za ${minutes} ${plural(minutes, 'minutu', 'minuty', 'minut')}.`,
  submitFailedFallback: 'Odeslání se nezdařilo',
  networkError: 'Chyba sítě. Zkontrolujte prosím připojení.',
  submissionFailedTitle: 'Odeslání se nezdařilo',
  submissionErrors: {
    INVALID_JSON: 'Neplatný požadavek. Zkuste to prosím znovu.',
    INVALID_SUBMITTER: 'Zkontrolujte jméno nebo e-mailovou adresu a zkuste to znovu.',
    MISSING_REQUIRED_FIELDS: 'Repozitář a název jsou povinné.',
    INVALID_APP_VERSION: 'Verze aplikace je neplatná. Kontaktujte prosím správce webu.',
    INVALID_SCREENSHOT: 'Snímek obrazovky je neplatný. Pořiďte ho prosím znovu.',
    SCREENSHOT_TOO_LARGE: 'Snímek obrazovky je příliš velký. Vyberte prosím menší oblast.',
    INVALID_ATTACHMENT: 'Příloha je neplatná. Odeberte ji prosím a zkuste to znovu.',
    TOO_MANY_ATTACHMENTS: 'Příliš mnoho příloh. Některé soubory prosím odeberte.',
    UNSUPPORTED_ATTACHMENT_TYPE: 'Typ přílohy není podporován. Odeberte ji prosím.',
    ATTACHMENT_TOO_LARGE: 'Příloha je příliš velká. Odeberte ji prosím.',
    INVALID_REPOSITORY: 'Repozitář je neplatný. Kontaktujte prosím správce webu.',
    REPOSITORY_NOT_ALLOWED:
      'Tento repozitář nemůže přijímat zpětnou vazbu. Kontaktujte prosím správce webu.',
    AUTH_REQUIRED: 'Autorizace se nezdařila. Načtěte stránku znovu nebo kontaktujte správce webu.',
    APP_NOT_INSTALLED: 'Aplikace GitHub není pro tento repozitář nainstalována.',
    ISSUE_CREATION_FAILED: 'Issue se nepodařilo vytvořit. Zkuste to prosím později.',
  },
  tryAgain: 'Zkusit znovu',
  // Success modal
  successTitle: 'Zpětná vazba odeslána!',
  issueCreated: (issueNumberHtml: string) => `Issue ${issueNumberHtml} byla vytvořena.`,
  feedbackSubmittedMessage: 'Vaše zpětná vazba byla úspěšně odeslána.',
  viewOnGitHub: 'Zobrazit na GitHubu',
  done: 'Hotovo',
  // Screenshot options
  captureScreenshotTitle: 'Pořídit snímek obrazovky',
  chooseWhatToCapture: 'Vyberte, co má být na snímku:',
  viewportRedactionWarning:
    'Při zachycení viditelné oblasti prohlížečem nelze soukromá pole zakrýt automaticky. Chcete-li automatické zakrytí zachovat, zvolte „Vybrat prvek“, nebo citlivá místa před odesláním zkontrolujte a zakryjte.',
  redactionReviewNote:
    'Tento web označil některá pole k zakrytí. Snímek před odesláním zkontrolujte.',
  pageTooComplexViewportNote:
    'Stránka je pro zachycení celé stránky nebo oblasti příliš složitá. Zachyťte místo toho viditelnou oblast nebo vyberte konkrétní prvek.',
  pageTooComplexElementNote:
    'Stránka je pro zachycení celé stránky nebo oblasti příliš složitá. Vyberte místo toho konkrétní prvek.',
  fullPage: 'Celá stránka',
  viewportCaptureAlternative: 'Problémy se snímkem? Zachyťte místo toho viditelnou oblast',
  captureViewport: 'Zachytit viditelnou oblast',
  selectArea: 'Vybrat oblast',
  selectElement: 'Vybrat prvek',
  skipScreenshot: 'Přeskočit snímek',
  // Element & area pickers
  areaPickerInstruction: 'Tažením vyberte oblast, kterou chcete zachytit',
  areaPickerRedactionInstruction:
    'Tažením vyberte oblast, kterou chcete zachytit. Označená soukromá pole v ní mohou být zakryta.',
  elementPickerInstruction: 'Klikněte na prvek, který chcete zachytit',
  elementPickerTouchInstruction: 'Klepněte na prvek, který chcete zachytit',
  escToCancel: 'ESC pro zrušení',
  // Capture loading & failures
  capturingTitle: 'Zachytávání...',
  capturingScreenshot: 'Pořizuje se snímek obrazovky...',
  captureFailedTitle: 'Snímek se nezdařil',
  captureFailedMessage:
    'Snímek obrazovky se nepodařilo pořídit. Stránka může být příliš složitá nebo to neumožňuje prohlížeč.',
  chooseAnotherMethod: 'Zvolit jiný způsob',
  maskFailureTitle: 'Zakrytí soukromých údajů se nezdařilo',
  maskFailureMessage:
    'Soukromá pole se nepodařilo automaticky zakrýt. V zájmu ochrany vašich údajů byl snímek zahozen. Zpětnou vazbu můžete odeslat i bez něj.',
  continueWithoutScreenshot: 'Pokračovat bez snímku',
  // Annotation step
  reviewScreenshotTitle: 'Zkontrolovat snímek',
  editScreenshotTitle: 'Upravit snímek',
  reviewButton: 'Zkontrolovat',
  backToEdit: 'Upravit',
  reviewInstruction: 'Snímek před odesláním zkontrolujte. Můžete se vrátit a provést změny.',
  retakeConfirmTitle: 'Pořídit snímek znovu?',
  retakeConfirmMessage: 'Úpravy tohoto snímku budou ztraceny.',
  keepEditing: 'Pokračovat v úpravách',
  discardAndRetake: 'Zahodit a pořídit znovu',
  viewportRedactionUnavailableNote:
    'Na tomto snímku viditelné oblasti nebylo možné soukromá pole zakrýt automaticky. Citlivá místa před odesláním zkontrolujte a zakryjte.',
  redactionCountNote: (count: number) =>
    `Na tomto snímku je k zakrytí označeno: ${count} ${plural(count, 'soukromý prvek', 'soukromé prvky', 'soukromých prvků')}. Před odesláním snímek zkontrolujte.`,
  redactionLimitationsNote:
    'BugDrop zakryl pouze změřené označené oblasti. Nekontroluje pixely uvnitř vloženého nebo vykresleného obsahu, jako jsou prvky iframe, canvas, obrázky, SVG, videa, pozadí CSS nebo vlastní ovládací prvky. Před odesláním ověřte, že černý obdélník citlivou oblast zcela zakrývá, nebo označte větší nadřazený prvek a pořiďte snímek znovu.',
  annotationInstruction:
    'Před odesláním zkontrolujte, zda nejsou vidět citlivé údaje. Citlivá místa před odesláním zakryjte. Zakrytí se stane trvalou součástí nahraného obrázku.',
  selectedElementNote: (linkHtml: string) =>
    `Potřebujete zachytit více okolního obsahu? Upravte ${linkHtml} ve značce skriptu BugDrop.`,
  toolDraw: 'Kreslit',
  toolArrow: 'Šipka',
  toolRectangle: 'Obdélník',
  toolRedact: 'Zakrýt',
  toolPan: 'Posunout',
  fitWidth: 'Na šířku',
  viewControls: 'Ovládání přiblížení',
  zoomIn: 'Přiblížit',
  zoomOut: 'Oddálit',
  resetView: 'Obnovit zobrazení',
  undo: 'Zpět',
  retake: 'Pořídit znovu',
  submitFeedback: 'Odeslat zpětnou vazbu',
  // Capture timeout
  captureTimeout: 'Vypršel časový limit pro pořízení snímku — stránka může být příliš složitá',
};
