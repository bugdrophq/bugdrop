import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

type Runner = 'fixed' | 'private';
type FeedbackPayload = Record<string, unknown> & {
  title: string;
  description: string;
  category: string;
  screenshot: string | null;
  attachments: unknown[];
  consoleLogs?: Array<Record<string, unknown>>;
  submitter?: { name?: string; email?: string };
  metadata: Record<string, unknown> & {
    timestamp?: string;
    elementSelector?: string | null;
    fullElementSelector?: string | null;
  };
};
type JourneyResult = { trace: string[]; requests: FeedbackPayload[] };
type Journey = (page: Page, trace: string[], requests: FeedbackPayload[]) => Promise<void>;

const welcomeStorageKey = 'bugdrop_welcomed_mean-weasel/bugdrop-widget-test';
const stubPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function host(page: Page) {
  return page.locator('#bugdrop-host');
}

async function prepareContext(context: BrowserContext, runner: Runner, captureHook?: string) {
  await context.addInitScript(selected => {
    (window as unknown as { __bugdropDefaultFlowRuntime?: string }).__bugdropDefaultFlowRuntime =
      selected;
  }, runner);
  if (captureHook) await context.addInitScript({ content: captureHook });
}

async function runJourney(
  browser: Browser,
  runner: Runner,
  journey: Journey,
  captureHook?: string
): Promise<JourneyResult> {
  const context = await browser.newContext();
  await prepareContext(context, runner, captureHook);
  const page = await context.newPage();
  const requests: FeedbackPayload[] = [];
  const trace: string[] = [];

  await page.route('**/api/check**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ installed: true }),
    })
  );
  await page.route('**/feedback', async route => {
    requests.push(route.request().postDataJSON() as FeedbackPayload);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        issueNumber: 42,
        issueUrl: 'https://github.com/example/project/issues/42',
        isPublic: false,
      }),
    });
  });

  try {
    await journey(page, trace, requests);
    return { trace, requests: requests.map(normalizePayload) };
  } finally {
    await context.close();
  }
}

async function expectPairedJourney(
  browser: Browser,
  journey: Journey,
  captureHook?: string
): Promise<JourneyResult> {
  const fixed = await runJourney(browser, 'fixed', journey, captureHook);
  const flowRuntime = await runJourney(browser, 'private', journey, captureHook);
  expect(flowRuntime.trace).toEqual(fixed.trace);
  expect(flowRuntime.requests).toEqual(fixed.requests);
  return fixed;
}

function normalizePayload(payload: FeedbackPayload): FeedbackPayload {
  return {
    ...payload,
    ...(payload.consoleLogs
      ? {
          consoleLogs: payload.consoleLogs.map(entry => ({
            ...entry,
            ...('timestamp' in entry ? { timestamp: '<timestamp>' } : {}),
          })),
        }
      : {}),
    metadata: { ...payload.metadata, timestamp: '<timestamp>' },
  };
}

async function observe(page: Page, trace: string[], label: string) {
  const state = await page.evaluate(() => {
    const root = document.querySelector('#bugdrop-host')?.shadowRoot;
    const visible = (element: Element | null) =>
      element instanceof HTMLElement && element.getClientRects().length > 0;
    const value = (selector: string) =>
      (root?.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null)?.value ??
      null;
    const checked = (selector: string) =>
      (root?.querySelector(selector) as HTMLInputElement | null)?.checked ?? null;

    return {
      title: root?.querySelector('.bd-title')?.textContent?.trim() ?? null,
      actions: [...(root?.querySelectorAll('[data-action]') ?? [])]
        .filter(visible)
        .map(element => (element as HTMLElement).dataset.action),
      form: {
        title: value('#title'),
        description: value('#description'),
        category: value('input[name="category"]:checked'),
        name: value('#name'),
        email: value('#email'),
        screenshot: checked('#include-screenshot'),
        consoleLogs: checked('#send-console-logs'),
        uploads:
          root?.querySelector('#attachment-list')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      },
      annotation: visible(root?.querySelector('#annotation-canvas') ?? null),
      error: root?.querySelector('.bd-error-message__text')?.textContent?.trim() ?? null,
      success: visible(root?.querySelector('.bd-success-icon') ?? null),
    };
  });
  trace.push(JSON.stringify({ state: label, ...state }));
}

async function act(page: Page, trace: string[], action: string, selector: string) {
  trace.push(`action:${action}`);
  await host(page).locator(`css=${selector}`).click();
}

async function waitForWidget(page: Page) {
  await expect(host(page).locator('css=.bd-trigger')).toBeVisible({ timeout: 5000 });
}

async function openFromPublicApi(page: Page, trace: string[]) {
  await page.waitForFunction(() => typeof window.BugDrop !== 'undefined');
  trace.push('action:public-open');
  await page.evaluate(() => window.BugDrop?.open());
  await expect(host(page).locator('css=#title')).toBeVisible();
  await observe(page, trace, 'details');
}

async function fillBaseForm(page: Page, title: string, description = `${title} description`) {
  const widget = host(page);
  await widget.locator('css=#title').fill(title);
  await widget.locator('css=#description').fill(description);
}

function successfulCaptureHook() {
  return `window.__bugdropMockToPng = function() {
    window.__captureCount = (window.__captureCount || 0) + 1;
    return Promise.resolve('${stubPng}');
  };`;
}

function firstCaptureFailsHook() {
  return `window.__bugdropMockToPng = function() {
    window.__captureCount = (window.__captureCount || 0) + 1;
    if (window.__captureCount === 1) return Promise.reject(new Error('paired failure'));
    return Promise.resolve('${stubPng}');
  };`;
}

function viewportCaptureHook() {
  return `window.__bugdropMockViewportCapture = function() {
    window.__viewportCaptureCount = (window.__viewportCaptureCount || 0) + 1;
    return Promise.resolve('${stubPng}');
  };`;
}

function redactionAwareCaptureHook() {
  return `window.__bugdropMockToPng = function(el, opts) {
    var canvas = document.createElement('canvas');
    var pixelRatio = opts && opts.pixelRatio ? opts.pixelRatio : 1;
    canvas.width = Math.max(1, Math.ceil((opts && opts.width ? opts.width : document.documentElement.scrollWidth) * pixelRatio));
    canvas.height = Math.max(1, Math.ceil((opts && opts.height ? opts.height : document.documentElement.scrollHeight) * pixelRatio));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return Promise.resolve(canvas.toDataURL('image/png'));
  };`;
}

function assertLegacySchema(payload: FeedbackPayload) {
  expect(Object.keys(payload).sort()).toEqual([
    'attachments',
    'category',
    'consoleLogs',
    'description',
    'metadata',
    'repo',
    'screenshot',
    'submitter',
    'title',
  ]);
  expect(Object.keys(payload.metadata).sort()).toEqual([
    'browser',
    'devicePixelRatio',
    'domNodeCount',
    'elementSelector',
    'fullElementSelector',
    'fullPageDisabled',
    'language',
    'os',
    'timestamp',
    'url',
    'userAgent',
    'viewport',
  ]);
}

test.describe('paired default-flow screenshot compatibility oracle', () => {
  test('preserves the trigger journey and explicit legacy request schema', async ({ browser }) => {
    const result = await expectPairedJourney(browser, async (page, trace, requests) => {
      await page.goto('/test/?showName=true&showEmail=true&sendConsoleLogs=true');
      await page.evaluate(key => localStorage.removeItem(key), welcomeStorageKey);
      await page.reload();
      await waitForWidget(page);

      await act(page, trace, 'trigger', '.bd-trigger');
      await expect(host(page).locator('css=[data-action="continue"]')).toBeVisible();
      await observe(page, trace, 'welcome');
      await act(page, trace, 'continue', '[data-action="continue"]');
      await observe(page, trace, 'details');

      const widget = host(page);
      await widget.locator('css=input[name="category"][value="feature"]').check();
      await widget.locator('css=#title').fill('  Compatibility title  ');
      await widget.locator('css=#description').fill('  Compatibility description  ');
      await widget.locator('css=#name').fill('  Ada  ');
      await widget.locator('css=#email').fill('  ada@example.com  ');
      await widget.locator('css=#include-screenshot').uncheck();
      await observe(page, trace, 'completed-details');
      await act(page, trace, 'submit', '#submit-btn');
      await expect(widget.locator('css=.bd-success-icon')).toBeVisible();
      await observe(page, trace, 'success');
      expect(requests).toHaveLength(1);

      await act(page, trace, 'done', '[data-action="done"]');
      await act(page, trace, 'trigger', '.bd-trigger');
      await expect(widget.locator('css=[data-action="continue"]')).not.toBeAttached();
      await expect(widget.locator('css=#title')).toBeVisible();
      await observe(page, trace, 'details-after-welcome-persistence');
    });

    const payload = result.requests[0];
    assertLegacySchema(payload);
    expect(payload).toMatchObject({
      repo: 'mean-weasel/bugdrop-widget-test',
      title: 'Compatibility title',
      description: 'Compatibility description',
      category: 'feature',
      screenshot: null,
      attachments: [],
      submitter: { name: 'Ada', email: 'ada@example.com' },
      metadata: {
        elementSelector: null,
        fullElementSelector: null,
        fullPageDisabled: false,
      },
    });
  });

  test('optional annotated capture preserves details through Retake and Close', async ({
    browser,
  }) => {
    const result = await expectPairedJourney(
      browser,
      async (page, trace, requests) => {
        await page.goto('/test/?showName=true&showEmail=true');
        await waitForWidget(page);
        await openFromPublicApi(page, trace);

        const widget = host(page);
        await widget.locator('css=input[name="category"][value="question"]').check();
        await fillBaseForm(page, 'Retained optional title', 'Retained optional description');
        await widget.locator('css=#name').fill('Grace');
        await widget.locator('css=#email').fill('grace@example.com');
        await widget.locator('css=#attachment-upload').setInputFiles({
          name: 'evidence.png',
          mimeType: 'image/png',
          buffer: Buffer.from('paired optional evidence'),
        });
        await observe(page, trace, 'completed-details');

        await act(page, trace, 'continue-to-capture', '#submit-btn');
        await observe(page, trace, 'screenshot-options');
        await act(page, trace, 'capture', '[data-action="capture"]');
        await expect(widget.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });
        await observe(page, trace, 'annotation');
        await act(page, trace, 'retake', '[data-action="retake"]');
        await observe(page, trace, 'screenshot-options-after-retake');
        await act(page, trace, 'capture', '[data-action="capture"]');
        await expect(widget.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });
        await act(page, trace, 'close-annotation', '.bd-close');

        await expect(widget.locator('css=#title')).toHaveValue('Retained optional title');
        await expect(widget.locator('css=#description')).toHaveValue(
          'Retained optional description'
        );
        await expect(widget.locator('css=input[name="category"][value="question"]')).toBeChecked();
        await expect(widget.locator('css=#name')).toHaveValue('Grace');
        await expect(widget.locator('css=#email')).toHaveValue('grace@example.com');
        await expect(widget.locator('css=.bd-upload-item')).toContainText('evidence.png');
        await observe(page, trace, 'retained-details-after-close');

        await act(page, trace, 'continue-to-capture', '#submit-btn');
        await act(page, trace, 'capture', '[data-action="capture"]');
        await expect(widget.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });
        await act(page, trace, 'submit-annotation', '[data-action="done"]');
        await expect(widget.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
        await observe(page, trace, 'success');
        expect(requests).toHaveLength(1);
      },
      successfulCaptureHook()
    );

    expect(result.requests[0]).toMatchObject({
      title: 'Retained optional title',
      description: 'Retained optional description',
      category: 'question',
      screenshot: expect.stringMatching(/^data:image\/png;base64,/),
      attachments: [
        expect.objectContaining({
          name: 'evidence.png',
          type: 'image/png',
          dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        }),
      ],
      metadata: { elementSelector: null, fullElementSelector: null },
    });
  });

  test('viewport capture exposes privacy limits and submits empty selector metadata', async ({
    browser,
  }) => {
    const result = await expectPairedJourney(
      browser,
      async (page, trace, requests) => {
        await page.goto('/test/complex-dom.html?nodes=12000&private=redacted#secret');
        await waitForWidget(page);
        await openFromPublicApi(page, trace);
        await fillBaseForm(page, 'Viewport privacy proof');
        await act(page, trace, 'continue-to-capture', '#submit-btn');

        const widget = host(page);
        await expect(widget.locator('css=[data-action="viewport"]')).toBeVisible();
        await expect(widget.locator('css=.bd-redaction-note')).not.toBeAttached();
        await observe(page, trace, 'viewport-options-with-privacy-notice');
        await act(page, trace, 'capture-viewport', '[data-action="viewport"]');
        await expect(widget.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });
        await expect(widget.locator('css=.bd-redaction-note')).toContainText(
          'could not apply automatic private-field masks'
        );
        await observe(page, trace, 'viewport-annotation-with-privacy-notice');
        await act(page, trace, 'submit-viewport', '[data-action="done"]');
        await expect(widget.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
        expect(requests).toHaveLength(1);
        expect(
          await page.evaluate(
            () => (window as Window & { __viewportCaptureCount?: number }).__viewportCaptureCount
          )
        ).toBe(1);
      },
      viewportCaptureHook()
    );

    expect(result.requests[0]).toMatchObject({
      screenshot: expect.stringMatching(/^data:image\/png;base64,/),
      metadata: {
        url: 'http://localhost:8787/test/complex-dom',
        elementSelector: null,
        fullElementSelector: null,
      },
    });
  });

  test('area capture reports redaction and annotation Undo restores its baseline', async ({
    browser,
  }) => {
    const result = await expectPairedJourney(
      browser,
      async (page, trace, requests) => {
        await page.goto('/test/redaction.html?private=redacted#secret');
        await page.locator('#redacted-test-input').scrollIntoViewIfNeeded();
        await waitForWidget(page);
        await openFromPublicApi(page, trace);
        await fillBaseForm(page, 'Area redaction and undo');
        await act(page, trace, 'continue-to-capture', '#submit-btn');
        await expect(host(page).locator('css=.bd-redaction-note')).toContainText(
          'marked some fields for redaction'
        );
        await act(page, trace, 'select-area', '[data-action="area"]');
        await expect(page.locator('#bugdrop-area-picker-overlay')).toBeVisible();
        await expect(page.locator('#bugdrop-area-picker-tooltip')).toContainText(
          'Marked private fields may be masked if included'
        );

        const box = await page.locator('#redacted-test-input').boundingBox();
        expect(box).not.toBeNull();
        trace.push('action:drag-redacted-area');
        await page.mouse.move(box!.x - 8, box!.y - 8);
        await page.mouse.down();
        await page.mouse.move(box!.x + box!.width + 8, box!.y + box!.height + 8);
        await page.mouse.up();

        const canvas = host(page).locator('css=#annotation-canvas canvas');
        await expect(canvas).toBeVisible({ timeout: 10000 });
        await expect(host(page).locator('css=.bd-redaction-note')).toContainText(
          '1 private item was marked for redaction'
        );
        const baseline = await canvas.evaluate(element =>
          (element as HTMLCanvasElement).toDataURL()
        );
        const canvasBox = await canvas.boundingBox();
        expect(canvasBox).not.toBeNull();
        trace.push('action:draw-annotation');
        await page.mouse.move(canvasBox!.x + 20, canvasBox!.y + 20);
        await page.mouse.down();
        await page.mouse.move(canvasBox!.x + 100, canvasBox!.y + 70, { steps: 5 });
        await page.mouse.up();
        expect(
          await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL())
        ).not.toBe(baseline);
        await act(page, trace, 'undo-annotation', '[data-action="undo"]');
        expect(await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL())).toBe(
          baseline
        );
        await act(page, trace, 'submit-area', '[data-action="done"]');
        await expect(host(page).locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
        expect(requests).toHaveLength(1);
      },
      redactionAwareCaptureHook()
    );

    expect(result.requests[0]).toMatchObject({
      screenshot: expect.stringMatching(/^data:image\/png;base64,/),
      metadata: {
        url: 'http://localhost:8787/test/redaction',
        elementSelector: null,
        fullElementSelector: null,
      },
    });
  });

  test('automatic capture succeeds without exposing the picker or annotation', async ({
    browser,
  }) => {
    const result = await expectPairedJourney(
      browser,
      async (page, trace, requests) => {
        await page.goto('/test/?screenshot=auto');
        await waitForWidget(page);
        await openFromPublicApi(page, trace);
        await fillBaseForm(page, 'Automatic success');
        await act(page, trace, 'submit', '#submit-btn');
        await expect(host(page).locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
        await expect(host(page).locator('css=[data-action="capture"]')).not.toBeAttached();
        await expect(host(page).locator('css=#annotation-canvas')).not.toBeAttached();
        await observe(page, trace, 'success');
        expect(requests).toHaveLength(1);
        expect(
          await page.evaluate(() => (window as Window & { __captureCount?: number }).__captureCount)
        ).toBe(1);
      },
      successfulCaptureHook()
    );

    expect(result.requests[0].screenshot).toBe(stubPng);
  });

  test('automatic capture failure offers only skip and submits without a screenshot', async ({
    browser,
  }) => {
    const result = await expectPairedJourney(
      browser,
      async (page, trace, requests) => {
        await page.goto('/test/?screenshot=auto');
        await waitForWidget(page);
        await openFromPublicApi(page, trace);
        await fillBaseForm(page, 'Automatic failure');
        await act(page, trace, 'submit', '#submit-btn');
        await expect(host(page).locator('css=.bd-error-message__text')).toBeVisible();
        await expect(host(page).locator('css=[data-action="choose-again"]')).not.toBeAttached();
        await observe(page, trace, 'capture-failure');
        await act(page, trace, 'skip-failed-capture', '[data-action="skip"]');
        await expect(host(page).locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
        await observe(page, trace, 'success');
        expect(requests).toHaveLength(1);
      },
      `window.__bugdropMockToPng = function() { return Promise.reject(new Error('auto failure')); };`
    );

    expect(result.requests[0].screenshot).toBeNull();
  });

  test('automatic capture bypasses capture entirely on a very complex page', async ({
    browser,
  }) => {
    const result = await expectPairedJourney(
      browser,
      async (page, trace, requests) => {
        await page.goto('/test/complex-dom.html?nodes=12000&screenshot=auto');
        await waitForWidget(page);
        await openFromPublicApi(page, trace);
        await fillBaseForm(page, 'Automatic complex bypass');
        await act(page, trace, 'submit', '#submit-btn');
        await expect(host(page).locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
        await observe(page, trace, 'success');
        expect(requests).toHaveLength(1);
        expect(
          await page.evaluate(() => (window as Window & { __captureCount?: number }).__captureCount)
        ).toBeUndefined();
      },
      successfulCaptureHook()
    );

    expect(result.requests[0]).toMatchObject({
      screenshot: null,
      metadata: { fullPageDisabled: true },
    });
  });

  test('required mode omits skip, recovers from failure, and submits attachment and selector metadata', async ({
    browser,
  }) => {
    const result = await expectPairedJourney(
      browser,
      async (page, trace, requests) => {
        await page.goto('/test/?screenshot=required');
        await waitForWidget(page);
        await openFromPublicApi(page, trace);
        await fillBaseForm(page, 'Required recovery');
        await host(page)
          .locator('css=#attachment-upload')
          .setInputFiles({
            name: 'notes.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from('%PDF-1.4\npaired required evidence'),
          });
        await observe(page, trace, 'completed-details');
        await act(page, trace, 'continue-to-capture', '#submit-btn');
        await expect(host(page).locator('css=[data-action="skip"]')).not.toBeAttached();
        await observe(page, trace, 'required-screenshot-options');

        await act(page, trace, 'capture', '[data-action="capture"]');
        await expect(host(page).locator('css=.bd-error-message__text')).toBeVisible();
        await expect(host(page).locator('css=[data-action="skip"]')).not.toBeAttached();
        await observe(page, trace, 'required-capture-failure');
        await act(page, trace, 'choose-again', '[data-action="choose-again"]');
        await expect(host(page).locator('css=[data-action="skip"]')).not.toBeAttached();
        await observe(page, trace, 'required-options-after-failure');

        await act(page, trace, 'select-element', '[data-action="element"]');
        await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible();
        trace.push('action:pick-h1');
        const targetBox = await page.locator('h1').boundingBox();
        expect(targetBox).not.toBeNull();
        await page.mouse.click(
          targetBox!.x + targetBox!.width / 2,
          targetBox!.y + targetBox!.height / 2
        );
        await expect(host(page).locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });
        await observe(page, trace, 'required-annotation');
        await act(page, trace, 'submit-annotation', '[data-action="done"]');
        await expect(host(page).locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
        await observe(page, trace, 'success');
        expect(requests).toHaveLength(1);
      },
      firstCaptureFailsHook()
    );

    const payload = result.requests[0];
    expect(payload).toMatchObject({
      screenshot: expect.stringMatching(/^data:image\/png;base64,/),
      attachments: [
        expect.objectContaining({
          name: 'notes.pdf',
          type: 'application/pdf',
          dataUrl: expect.stringMatching(/^data:application\/pdf;base64,/),
        }),
      ],
      metadata: {
        elementSelector: expect.stringContaining('h1'),
        fullElementSelector: expect.stringContaining('html > body'),
      },
    });
    expect(payload.metadata.fullElementSelector).toContain('h1');
  });

  for (const mode of ['auto', 'manual'] as const) {
    test(`pairs ${mode} capture cancellation and retained details`, async ({ browser }) => {
      await expectPairedJourney(
        browser,
        async (page, trace, requests) => {
          await page.goto(mode === 'auto' ? '/test/?screenshot=auto' : '/test/');
          await waitForWidget(page);
          await openFromPublicApi(page, trace);
          await fillBaseForm(page, `${mode} cancellation`, 'Retained after capture cancellation');
          await act(page, trace, 'submit-details', '#submit-btn');
          if (mode === 'manual') {
            await act(page, trace, 'capture-full-page', '[data-action="capture"]');
          }
          await expect(host(page).locator('css=.bd-error-message__text')).toBeVisible();
          await observe(page, trace, `${mode}-capture-failure`);
          await act(page, trace, 'close-capture-failure', '.bd-close');
          await expect(host(page).locator('css=#title')).toHaveValue(`${mode} cancellation`);
          await expect(host(page).locator('css=#description')).toHaveValue(
            'Retained after capture cancellation'
          );
          await observe(page, trace, `${mode}-retained-details`);
          expect(requests).toHaveLength(0);
          trace.push('action:public-close');
          await page.evaluate(() => window.BugDrop?.close());
        },
        `window.__bugdropMockToPng = function() { return Promise.reject(new Error('${mode} cancellation')); };`
      );
    });
  }

  for (const dismissal of ['close', 'cancel'] as const) {
    test(`submission-error ${dismissal} clears the draft before a clean reopen`, async ({
      browser,
    }) => {
      await expectPairedJourney(browser, async (page, trace, requests) => {
        await page.unroute('**/feedback');
        await page.route('**/feedback', async route => {
          requests.push(route.request().postDataJSON() as FeedbackPayload);
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, error: 'Dismiss and reopen' }),
          });
        });

        await page.goto('/test/');
        await waitForWidget(page);
        await openFromPublicApi(page, trace);
        await fillBaseForm(page, `Discarded ${dismissal} draft`, 'Must not survive reopen');
        await host(page).locator('css=#include-screenshot').uncheck();
        await act(page, trace, 'submit', '#submit-btn');
        await expect(host(page).locator('css=.bd-error-message__text')).toHaveText(
          'Dismiss and reopen'
        );
        await observe(page, trace, 'submission-error');
        await act(
          page,
          trace,
          `dismiss-error-${dismissal}`,
          dismissal === 'close' ? '.bd-close' : '[data-action="cancel"]'
        );
        await expect(host(page).locator('css=.bd-modal')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.BugDrop?.isOpen())).toBe(false);

        await openFromPublicApi(page, trace);
        await expect(host(page).locator('css=#title')).toHaveValue('');
        await expect(host(page).locator('css=#description')).toHaveValue('');
        await observe(page, trace, 'clean-details-after-error-dismissal');
        expect(requests).toHaveLength(1);
        trace.push('action:public-close');
        await page.evaluate(() => window.BugDrop?.close());
      });
    });
  }

  test('submission retry reuses the identical legacy request data', async ({ browser }) => {
    const journey: Journey = async (page, trace, requests) => {
      let attempts = 0;
      await page.unroute('**/feedback');
      await page.route('**/feedback', async route => {
        requests.push(route.request().postDataJSON() as FeedbackPayload);
        attempts += 1;
        await route.fulfill({
          status: attempts === 1 ? 500 : 200,
          contentType: 'application/json',
          body: JSON.stringify(
            attempts === 1
              ? { success: false, error: 'Compatibility failure' }
              : { success: true, issueNumber: 43, issueUrl: '#', isPublic: false }
          ),
        });
      });

      await page.goto('/test/');
      await waitForWidget(page);
      await openFromPublicApi(page, trace);
      await host(page).locator('css=input[name="category"][value="question"]').check();
      await fillBaseForm(page, 'Retry title', 'Retry description');
      await host(page).locator('css=#include-screenshot').uncheck();
      await act(page, trace, 'submit', '#submit-btn');
      await expect(host(page).locator('css=.bd-error-message__text')).toHaveText(
        'Compatibility failure'
      );
      await observe(page, trace, 'submission-error');
      await act(page, trace, 'retry', '[data-action="retry"]');
      await expect(host(page).locator('css=.bd-success-icon')).toBeVisible();
      await observe(page, trace, 'success');
      expect(requests).toHaveLength(2);
    };

    const result = await expectPairedJourney(browser, journey);
    expect(result.requests[1]).toEqual(result.requests[0]);
  });

  for (const failure of ['rate-limit', 'network'] as const) {
    test(`recollects console logs and metadata after ${failure} retry`, async ({ browser }) => {
      const result = await expectPairedJourney(browser, async (page, trace, requests) => {
        let attempts = 0;
        await page.unroute('**/feedback');
        await page.route('**/feedback', async route => {
          requests.push(route.request().postDataJSON() as FeedbackPayload);
          attempts += 1;
          if (attempts === 1 && failure === 'network') {
            await route.abort('failed');
            return;
          }
          await route.fulfill({
            status: attempts === 1 ? 429 : 200,
            headers: attempts === 1 ? { 'Retry-After': '60' } : undefined,
            contentType: 'application/json',
            body: JSON.stringify(
              attempts === 1
                ? { success: false }
                : { success: true, issueNumber: 45, issueUrl: '#', isPublic: false }
            ),
          });
        });

        await page.goto('/test/?sendConsoleLogs=true');
        await waitForWidget(page);
        await openFromPublicApi(page, trace);
        await fillBaseForm(page, `${failure} recollection`);
        await host(page).locator('css=#include-screenshot').uncheck();
        await act(page, trace, 'submit', '#submit-btn');
        await expect(host(page).locator('css=.bd-error-message__text')).toBeVisible();
        await page.evaluate(() => console.warn('paired retry-time evidence'));
        await page.setViewportSize({ width: 777, height: 555 });
        await act(page, trace, 'retry', '[data-action="retry"]');
        await expect(host(page).locator('css=.bd-success-icon')).toBeVisible();
        expect(requests).toHaveLength(2);
      });

      expect(result.requests[0].metadata.viewport).not.toEqual(
        result.requests[1].metadata.viewport
      );
      expect(result.requests[1].metadata.viewport).toEqual({ width: 777, height: 555 });
      expect(result.requests[1].consoleLogs).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: 'paired retry-time evidence' })])
      );
    });
  }

  for (const preflight of ['not_installed', 'unreachable'] as const) {
    test(`owns ${preflight} preflight while suppressing duplicate opens`, async ({ browser }) => {
      await expectPairedJourney(browser, async (page, trace, requests) => {
        let checks = 0;
        await page.unroute('**/api/check**');
        await page.route('**/api/check**', async route => {
          checks += 1;
          if (preflight === 'unreachable') {
            await route.fulfill({ status: 503, body: 'unavailable' });
          } else {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ installed: false, appName: 'paired-app' }),
            });
          }
        });

        await page.goto('/test/');
        await waitForWidget(page);
        trace.push('action:duplicate-public-open');
        await page.evaluate(() => {
          window.BugDrop?.open();
          window.BugDrop?.open();
        });
        await expect(host(page).locator('css=.bd-title')).toHaveText(
          preflight === 'unreachable' ? 'Connection Error' : 'Install Required'
        );
        expect(checks).toBe(1);
        expect(await page.evaluate(() => window.BugDrop?.isOpen())).toBe(true);
        await observe(page, trace, `preflight-${preflight}`);

        trace.push('action:public-close');
        await page.evaluate(() => window.BugDrop?.close());
        expect(await page.evaluate(() => window.BugDrop?.isOpen())).toBe(false);
        await expect(host(page).locator('css=.bd-modal')).toHaveCount(0);
        expect(requests).toHaveLength(0);
      });
    });
  }

  test('pairs API state, invalid-field focus, keyboard submit, mobile layout, and reduced motion', async ({
    browser,
  }) => {
    await expectPairedJourney(browser, async (page, trace, requests) => {
      await page.setViewportSize({ width: 390, height: 720 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/test/');
      await waitForWidget(page);

      await openFromPublicApi(page, trace);
      await page.evaluate(() => window.BugDrop?.open());
      await expect(host(page).locator('css=.bd-modal')).toHaveCount(1);
      expect(await page.evaluate(() => window.BugDrop?.isOpen())).toBe(true);

      await act(page, trace, 'invalid-submit', '#submit-btn');
      expect(
        await host(page)
          .locator('css=#title')
          .evaluate(element =>
            element.getRootNode() instanceof ShadowRoot
              ? (element.getRootNode() as ShadowRoot).activeElement?.id
              : null
          )
      ).toBe('title');

      const modalBox = await host(page).locator('css=.bd-modal').boundingBox();
      expect(modalBox).not.toBeNull();
      expect(modalBox!.x).toBeGreaterThanOrEqual(0);
      expect(modalBox!.width).toBeLessThanOrEqual(390);
      expect(
        await host(page)
          .locator('css=.bd-modal')
          .evaluate(element => getComputedStyle(element).transitionDuration)
      ).toBe('1e-05s');

      await fillBaseForm(page, 'Keyboard mobile submission');
      await host(page).locator('css=#include-screenshot').uncheck();
      trace.push('action:keyboard-submit');
      await host(page).locator('css=#title').press('Enter');
      await expect(host(page).locator('css=.bd-success-icon')).toBeVisible();
      await observe(page, trace, 'mobile-success');
      expect(requests).toHaveLength(1);
      expect(requests[0].metadata.viewport).toEqual({ width: 390, height: 720 });
    });
  });

  test('pairs optional skip and element-picker cancellation retention boundaries', async ({
    browser,
  }) => {
    const result = await expectPairedJourney(browser, async (page, trace, requests) => {
      await page.goto('/test/complex-dom.html?nodes=12000');
      await waitForWidget(page);
      await openFromPublicApi(page, trace);
      await fillBaseForm(page, 'Picker cancellation');
      await act(page, trace, 'continue-to-capture', '#submit-btn');
      await act(page, trace, 'select-element', '[data-action="element"]');
      await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible();
      trace.push('action:cancel-picker');
      await page.keyboard.press('Escape');
      await expect(host(page).locator('css=.bd-success-icon')).toBeVisible();
      expect(requests).toHaveLength(1);

      await act(page, trace, 'done', '[data-action="done"]');
      await openFromPublicApi(page, trace);
      await expect(host(page).locator('css=#include-screenshot')).toBeChecked();
      await fillBaseForm(page, 'Explicit optional skip');
      await host(page).locator('css=#include-screenshot').uncheck();
      await act(page, trace, 'explicit-skip-submit', '#submit-btn');
      await expect(host(page).locator('css=.bd-success-icon')).toBeVisible();
      expect(requests).toHaveLength(2);
    });

    expect(result.requests.map(request => request.screenshot)).toEqual([null, null]);
    expect(result.requests[0].metadata).toMatchObject({
      elementSelector: null,
      fullElementSelector: null,
    });
  });

  test('pairs optional capture-failure skip and complex-page preference retention', async ({
    browser,
  }) => {
    const result = await expectPairedJourney(
      browser,
      async (page, trace, requests) => {
        await page.goto('/test/complex-dom.html?nodes=12000');
        await waitForWidget(page);
        await openFromPublicApi(page, trace);
        await fillBaseForm(page, 'Remember complex failure skip');
        await act(page, trace, 'continue-to-capture', '#submit-btn');
        await act(page, trace, 'select-element', '[data-action="element"]');
        await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible();
        trace.push('action:pick-heading');
        const headingBox = await page.locator('h1').boundingBox();
        expect(headingBox).not.toBeNull();
        await page.mouse.click(
          headingBox!.x + headingBox!.width / 2,
          headingBox!.y + headingBox!.height / 2
        );
        await expect(host(page).locator('css=.bd-error-message__text')).toBeVisible();
        await act(page, trace, 'skip-failed-capture', '[data-action="skip"]');
        await expect(host(page).locator('css=.bd-success-icon')).toBeVisible();
        expect(requests).toHaveLength(1);

        await act(page, trace, 'done', '[data-action="done"]');
        await openFromPublicApi(page, trace);
        await expect(host(page).locator('css=#include-screenshot')).not.toBeChecked();
        await observe(page, trace, 'remembered-complex-skip');
      },
      `window.__bugdropMockToPng = function() { return Promise.reject(new Error('complex optional failure')); };`
    );

    expect(result.requests[0].screenshot).toBeNull();
  });

  test('pairs default and modal-variant coordination', async ({ browser }) => {
    await expectPairedJourney(browser, async (page, trace, requests) => {
      await page.goto('/test/');
      await waitForWidget(page);
      await openFromPublicApi(page, trace);

      const busyStatus = await page.evaluate(async () => {
        const handle = window.BugDrop!.registerVariant({
          id: 'paired-modal-coordination',
          presentation: { kind: 'modal' },
          content: { title: 'Paired modal variant' },
          fields: [{ id: 'message', type: 'shortText', label: 'Message', required: true }],
          issue: { title: 'Paired {{message}}' },
        });
        (
          window as Window & {
            __pairedVariant?: ReturnType<typeof window.BugDrop.registerVariant>;
          }
        ).__pairedVariant = handle;
        return (await handle.open().result).status;
      });
      expect(busyStatus).toBe('busy');
      trace.push(`variant-while-default:${busyStatus}`);

      await page.evaluate(() => window.BugDrop?.close());
      await page.evaluate(() =>
        (
          window as Window & {
            __pairedVariant?: ReturnType<NonNullable<typeof window.BugDrop>['registerVariant']>;
          }
        ).__pairedVariant?.open()
      );
      await expect(page.locator('[data-bugdrop-owned]')).toBeVisible();
      trace.push('variant-open');

      await page.evaluate(() => window.BugDrop?.open());
      await expect(page.locator('[data-bugdrop-owned]')).toHaveCount(0);
      await expect(host(page).locator('css=#title')).toBeVisible();
      trace.push('default-replaced-variant');
      expect(requests).toHaveLength(0);
    });
  });

  for (const policy of [
    { query: 'showIssueLink=always', isPublic: false, visible: true },
    { query: 'showIssueLink=never', isPublic: true, visible: false },
  ]) {
    test(`pairs issue-link policy ${policy.query}`, async ({ browser }) => {
      await expectPairedJourney(browser, async (page, trace, requests) => {
        await page.unroute('**/feedback');
        await page.route('**/feedback', async route => {
          requests.push(route.request().postDataJSON() as FeedbackPayload);
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              issueNumber: 44,
              issueUrl: 'https://github.com/example/project/issues/44',
              isPublic: policy.isPublic,
            }),
          });
        });
        await page.goto(`/test/?${policy.query}`);
        await waitForWidget(page);
        await openFromPublicApi(page, trace);
        await fillBaseForm(page, 'Issue link policy');
        await host(page).locator('css=#include-screenshot').uncheck();
        await act(page, trace, 'submit', '#submit-btn');
        await expect(host(page).locator('css=.bd-success-icon')).toBeVisible();
        await expect(host(page).locator('css=.bd-issue-link')).toHaveCount(policy.visible ? 1 : 0);
        trace.push(`issue-link:${policy.visible}`);
      });
    });
  }
});
