import { expect, test, type Page } from '@playwright/test';
import type { FlowConfig, FlowOpenOptions } from '../src/widget/flows/public-types';
import { flowRecipes, type FlowRecipeId } from '../test/fixtures/flow-recipes';

type Payload = Record<string, unknown> & {
  title: string;
  description: string;
  category: string;
  screenshot: string | null;
  attachments: Array<Record<string, unknown>>;
  consoleLogs?: Array<{ message?: string }>;
  submitter?: { name?: string; email?: string };
  metadata: Record<string, unknown>;
};

const stubPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function expectValidPngDataUrl(value: unknown): void {
  expect(value).toEqual(expect.stringMatching(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/));
  const bytes = Buffer.from((value as string).split(',')[1]!, 'base64');
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function materialPayload(payload: Payload): Payload {
  const metadata = { ...payload.metadata };
  delete metadata.timestamp;
  return { ...payload, metadata };
}

async function ready(page: Page, capture = false) {
  if (capture) {
    await page.addInitScript(png => {
      const target = window as Window & {
        __bugdropMockToPng?: () => Promise<string>;
        __captureCount?: number;
      };
      target.__bugdropMockToPng = () => {
        target.__captureCount = (target.__captureCount ?? 0) + 1;
        return Promise.resolve(png);
      };
    }, stubPng);
  }
  await page.route('**/api/check/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ installed: true, appName: 'neonwatty-bugdrop' }),
    })
  );
  await page.goto('/test/welcome-disabled.html?private=redacted#secret');
  await expect
    .poll(() => page.evaluate(() => typeof window.BugDrop?.registerFlow))
    .toBe('function');
}

async function openConfig(page: Page, config: FlowConfig, openOptions?: FlowOpenOptions) {
  await page.evaluate(
    ({ recipe, options }) => {
      const opened = window.BugDrop!.registerFlow(recipe).open(options);
      (window as Window & { __publicFlow?: typeof opened }).__publicFlow = opened;
    },
    { recipe: config, options: openOptions }
  );
  return page.locator(`body > [data-bugdrop-flow="${config.id}"]`);
}

async function openRecipe(page: Page, id: FlowRecipeId) {
  const recipe = flowRecipes[id];
  return openConfig(page, recipe.config, recipe.openOptions);
}

async function mockFeedback(page: Page, issueNumber: number, failFirst = false) {
  const payloads: Payload[] = [];
  let attempts = 0;
  await page.route('**/api/feedback', route => {
    payloads.push(route.request().postDataJSON() as Payload);
    attempts += 1;
    if (failFirst && attempts === 1) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Temporary failure' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        issueNumber,
        issueUrl: `https://github.com/mean-weasel/bugdrop-widget-test/issues/${issueNumber}`,
        isPublic: false,
      }),
    });
  });
  return payloads;
}

test.describe('public modal FlowConfig V1 representative recipes', () => {
  for (const overflow of ['', 'auto']) {
    test(`same-task default-to-flow handoff restores overflow ${JSON.stringify(overflow)}`, async ({
      page,
    }) => {
      await ready(page);
      await page.evaluate(value => {
        document.body.style.setProperty('overflow', value, value ? 'important' : '');
        const opener = document.createElement('button');
        opener.id = 'handoff-opener';
        opener.textContent = 'Open feedback';
        document.body.appendChild(opener);
        opener.focus();
        window.BugDrop!.open();
      }, overflow);
      await expect(page.getByRole('dialog', { name: 'Send Feedback' })).toBeVisible();

      await page.evaluate(config => {
        const handle = window.BugDrop!.registerFlow(config);
        window.BugDrop!.close();
        const opened = handle.open();
        (window as Window & { __publicFlow?: typeof opened }).__publicFlow = opened;
      }, flowRecipes['bug-report'].config);
      const flow = page.locator('[data-bugdrop-flow="bug-report"]');
      await expect(flow.getByRole('dialog')).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');
      await expect(flow.getByRole('dialog').getByRole('button').first()).toBeFocused();

      await page.evaluate(() =>
        (window as Window & { __publicFlow?: { close(): void } }).__publicFlow!.close()
      );
      await expect(flow).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe(overflow);
      expect(await page.evaluate(() => document.body.style.getPropertyPriority('overflow'))).toBe(
        overflow ? 'important' : ''
      );
      await expect(page.locator('#handoff-opener')).toBeFocused();
    });
  }

  test('bug-report completes its natural composable journey', async ({ page }) => {
    const payloads = await mockFeedback(page, 51, true);
    await ready(page, true);
    const canonicalPageUrl = new URL(page.url());
    canonicalPageUrl.search = '';
    canonicalPageUrl.hash = '';
    await page.evaluate(() => console.info('bug-report-log-marker'));
    const trigger = page.getByRole('button', { name: /feedback/i });
    await trigger.focus();
    const host = await openRecipe(page, 'bug-report');
    const root = host.locator('.bdv-root');

    await expect(root).toHaveAttribute('data-size', 'default');
    await expect(root).toHaveAttribute('data-columns', '2');
    await expect(root).toHaveAttribute('data-density', 'comfortable');
    await expect(root).not.toHaveClass(/bdv-dark/);
    expect(await root.evaluate(element => element.style.getPropertyValue('--bdv-accent'))).toBe(
      '#2563eb'
    );
    await expect(host.getByRole('heading', { name: 'Report a problem' })).toBeVisible();
    await expect(host.getByText('This takes about a minute.')).toBeVisible();
    await expect(host.getByText('Step 1 of 4')).toBeVisible();
    await host.getByRole('button', { name: 'Start report' }).click();
    await host.getByRole('button', { name: 'Add evidence' }).click();
    await expect(host.getByLabel('Summary')).toBeFocused();
    await expect(host.getByLabel('Summary')).toHaveAttribute('aria-invalid', 'true');
    await expect(host.locator('[data-bugdrop-field="summary"]')).toHaveAttribute('data-span', '2');
    await expect(host.locator('[data-bugdrop-field="steps"]')).toHaveAttribute('data-span', '2');
    await host.getByLabel('Summary').fill('Save crashes');
    await host.getByLabel('Steps to reproduce').fill('Open settings\nClick save');
    await host.getByRole('button', { name: 'Add evidence' }).click();
    await expect(host.locator('[data-bugdrop-field="files"]')).toHaveAttribute('data-span', '2');
    await host.getByLabel('Attachments').setInputFiles({
      name: 'trace.png',
      mimeType: 'image/png',
      buffer: Buffer.from('local trace'),
    });
    await expect(host.getByText('trace.png')).toBeVisible();
    await expect(host.getByLabel('Include console logs')).toBeChecked();
    await expect(host.getByLabel('Your name')).toHaveAttribute('maxlength', '100');
    await expect(host.getByLabel('Email')).toHaveAttribute('maxlength', '254');
    await host.getByLabel('Your name').fill(' Ada ');
    await host.getByLabel('Email').fill(' ada@example.com ');
    await host.getByRole('button', { name: 'Continue' }).click();
    await expect(host.getByRole('heading', { name: 'Show us the problem' })).toBeVisible();
    await expect(host.getByLabel('Include a screenshot')).toHaveCount(0);
    await host.getByRole('button', { name: 'Submit' }).click();

    const capture = host.locator('[data-flow-capture="true"]');
    await expect(capture.getByRole('heading', { name: 'Capture Screenshot' })).toBeVisible();
    await expect(capture.getByText('Step 4 of 4')).toBeVisible();
    await expect(page.locator('#bugdrop-host .bd-overlay')).toHaveCount(0);
    await expect(capture.getByRole('button', { name: /skip screenshot/i })).toHaveCount(0);
    await capture.locator('[data-action="capture"]').focus();
    await page.keyboard.press('Enter');
    await expect(capture.locator('#annotation-canvas canvas')).toBeVisible();
    await expect(capture.locator('[data-action="done"]')).toBeInViewport();
    await capture.locator('[data-action="done"]').focus();
    await page.keyboard.press('Enter');
    await expect(host.getByText('Temporary failure')).toBeVisible();
    await expect(host.getByRole('button', { name: 'Discard report' })).toBeVisible();
    await host.getByRole('button', { name: 'Try again' }).click();
    await expect(host.getByRole('heading', { name: 'Report received' })).toBeVisible();
    await expect(host.getByText('Thanks for helping us fix this.')).toBeVisible();

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      title: 'Bug: Save crashes',
      category: 'bug',
      submitter: { name: 'Ada', email: 'ada@example.com' },
      attachments: [
        expect.objectContaining({
          name: 'trace.png',
          type: 'image/png',
          dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        }),
      ],
      metadata: {
        url: canonicalPageUrl.toString(),
        elementSelector: null,
        fullElementSelector: null,
      },
    });
    expectValidPngDataUrl(payloads[0].screenshot);
    expect(materialPayload(payloads[1]!)).toEqual(materialPayload(payloads[0]!));
    expect(payloads[0].description).toContain('> Open settings\n> Click save');
    expect(payloads[0].consoleLogs?.some(entry => entry.message === 'bug-report-log-marker')).toBe(
      true
    );
    expect(
      await page.evaluate(
        () =>
          (window as Window & { __publicFlow?: { result: Promise<unknown> } }).__publicFlow?.result
      )
    ).toEqual({
      status: 'submitted',
      result: {
        issueNumber: 51,
        issueUrl: 'https://github.com/mean-weasel/bugdrop-widget-test/issues/51',
        isPublic: false,
      },
    });
    await host.getByRole('button', { name: 'Done' }).click();
    await expect(trigger).toBeFocused();
  });

  test('registerFlow two-column modal stays contained and collapses at narrow viewports', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await ready(page);
    const config: FlowConfig = {
      configVersion: 1,
      id: 'responsive-two-column-proof',
      presentation: { kind: 'modal', size: 'wide', columns: 2 },
      forms: [
        {
          id: 'details',
          title: 'Responsive details',
          fields: [
            { id: 'summary', type: 'shortText', label: 'Summary' },
            { id: 'owner', type: 'shortText', label: 'Owner' },
          ],
        },
      ],
      screens: [{ id: 'details-screen', type: 'form', form: 'details' }],
      issue: { title: 'Responsive proof' },
    };
    const host = await openConfig(page, config);
    const root = host.locator('.bdv-root');
    const surface = host.locator('.bdv-surface');
    const fields = host.locator('.bdv-field');

    await expect(root).toHaveAttribute('data-columns', '2');
    await expect
      .poll(() =>
        host
          .locator('.bdv-fields')
          .evaluate(
            element =>
              getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
          )
      )
      .toBe(2);
    const wideFirst = await fields.nth(0).boundingBox();
    const wideSecond = await fields.nth(1).boundingBox();
    expect(wideFirst).not.toBeNull();
    expect(wideSecond).not.toBeNull();
    expect(wideSecond!.y).toBe(wideFirst!.y);
    expect(wideSecond!.x).toBeGreaterThan(wideFirst!.x);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        host
          .locator('.bdv-fields')
          .evaluate(
            element =>
              getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
          )
      )
      .toBe(1);
    const narrowFirst = await fields.nth(0).boundingBox();
    const narrowSecond = await fields.nth(1).boundingBox();
    const surfaceBox = await surface.boundingBox();
    expect(narrowFirst).not.toBeNull();
    expect(narrowSecond).not.toBeNull();
    expect(surfaceBox).not.toBeNull();
    expect(narrowSecond!.y).toBeGreaterThan(narrowFirst!.y);
    expect(surfaceBox!.x).toBeGreaterThanOrEqual(0);
    expect(surfaceBox!.x + surfaceBox!.width).toBeLessThanOrEqual(390);
    const surfaceWidths = await surface.evaluate(element => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    expect(surfaceWidths.scroll).toBeLessThanOrEqual(surfaceWidths.client);
  });

  test('registerFlow reduced motion removes Flow surface and control motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockFeedback(page, 56);
    await ready(page);
    const config: FlowConfig = {
      configVersion: 1,
      id: 'reduced-motion-proof',
      presentation: {
        kind: 'modal',
        screenTransition: { kind: 'slide-horizontal', durationMs: 420 },
      },
      forms: [
        {
          id: 'details',
          title: 'Reduced motion details',
          fields: [{ id: 'summary', type: 'shortText', label: 'Summary', required: true }],
        },
      ],
      screens: [{ id: 'details-screen', type: 'form', form: 'details' }],
      issue: { title: '{{details.summary}}' },
    };
    const host = await openConfig(page, config);
    const surface = host.locator('.bdv-surface');
    const input = host.getByLabel('Summary');
    const submit = host.getByRole('button', { name: 'Submit' });

    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true
    );
    await expect(surface).toBeVisible();
    expect(
      await Promise.all(
        [surface, input, submit].map(locator =>
          locator.evaluate(element => {
            const style = getComputedStyle(element);
            return {
              animationName: style.animationName,
              animationDuration: style.animationDuration,
              transitionDuration: style.transitionDuration,
            };
          })
        )
      )
    ).toEqual([
      { animationName: 'none', animationDuration: '0s', transitionDuration: '0s' },
      { animationName: 'none', animationDuration: '0s', transitionDuration: '0s' },
      { animationName: 'none', animationDuration: '0s', transitionDuration: '0s' },
    ]);
    await input.fill('No animated transition');
    await submit.click();
    await expect(host.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
    await expect(host.getByRole('button', { name: 'Done' })).toHaveCSS('transition-duration', '0s');
  });

  test('registerFlow applies opt-in horizontal screen motion in both directions', async ({
    page,
  }) => {
    await ready(page);
    const config: FlowConfig = {
      configVersion: 1,
      id: 'horizontal-transition-proof',
      presentation: {
        kind: 'modal',
        screenTransition: { kind: 'slide-horizontal', durationMs: 420 },
      },
      forms: [
        {
          id: 'details',
          title: 'Transition details',
          fields: [{ id: 'summary', type: 'shortText', label: 'Summary', required: true }],
        },
      ],
      screens: [
        { id: 'intro', type: 'message', title: 'Transition introduction' },
        { id: 'details-screen', type: 'form', form: 'details' },
      ],
      issue: { title: '{{details.summary}}' },
    };
    const host = await openConfig(page, config);

    const forwardState = await host.evaluate(element => {
      const root = element.shadowRoot!;
      root.querySelector<HTMLButtonElement>('.bdv-submit')!.click();
      return Array.from(root.querySelectorAll('.bdv-surface')).map(surface => ({
        className: surface.className,
        labelledBy: surface.getAttribute('aria-labelledby'),
        labelledTitle: root.getElementById(surface.getAttribute('aria-labelledby') ?? '')
          ?.textContent,
        animationName: getComputedStyle(surface).animationName,
        animationDuration: getComputedStyle(surface).animationDuration,
      }));
    });
    expect(forwardState).toEqual([
      {
        className: expect.stringContaining('bdf-slide-forward-exit'),
        labelledBy: expect.stringMatching(/-surface-\d+-title$/),
        labelledTitle: 'Transition introduction',
        animationName: 'bdf-slide-to-left',
        animationDuration: '0.42s',
      },
      {
        className: expect.stringContaining('bdf-slide-forward-enter'),
        labelledBy: expect.stringMatching(/-surface-\d+-title$/),
        labelledTitle: 'Transition details',
        animationName: 'bdf-slide-from-right',
        animationDuration: '0.42s',
      },
    ]);
    expect(forwardState[0]?.labelledBy).not.toBe(forwardState[1]?.labelledBy);
    await expect(host.getByRole('heading', { name: 'Transition details' })).toBeVisible();

    await expect(host.getByRole('button', { name: 'Back' })).toBeVisible();
    await host.getByRole('button', { name: 'Back' }).click();
    await expect
      .poll(() =>
        host.evaluate(element =>
          Array.from(element.shadowRoot!.querySelectorAll('.bdv-surface')).map(
            surface => surface.className
          )
        )
      )
      .toEqual([
        expect.stringContaining('bdf-slide-backward-exit'),
        expect.stringContaining('bdf-slide-backward-enter'),
      ]);
    await expect(host.getByRole('heading', { name: 'Transition introduction' })).toBeVisible();
  });

  test('registerFlow applies declarative custom motion inside the shadow root', async ({
    page,
  }) => {
    await ready(page);
    const config: FlowConfig = {
      configVersion: 1,
      id: 'custom-transition-proof',
      presentation: {
        kind: 'modal',
        screenTransition: {
          kind: 'custom',
          durationMs: 640,
          easing: 'linear',
          forward: {
            enterFrom: { opacity: 0.2, translateY: 40, scale: 0.9 },
            exitTo: { opacity: 0, translateY: -20 },
          },
          backward: {
            enterFrom: { opacity: 0.4, translateX: -30 },
            exitTo: { opacity: 0.1, translateX: 50, scale: 1.1 },
          },
        },
      },
      forms: [
        {
          id: 'details',
          title: 'Custom motion details',
          fields: [{ id: 'summary', type: 'shortText', label: 'Summary', required: true }],
        },
      ],
      screens: [
        { id: 'intro', type: 'message', title: 'Custom motion introduction' },
        { id: 'details-screen', type: 'form', form: 'details' },
      ],
      issue: { title: '{{details.summary}}' },
    };
    const host = await openConfig(page, config);

    const forward = await host.evaluate(element => {
      const root = element.shadowRoot!;
      root.querySelector<HTMLButtonElement>('.bdv-submit')!.click();
      const overlay = root.querySelector<HTMLElement>('.bdv-overlay')!;
      const incoming = root.querySelectorAll<HTMLElement>('.bdv-surface')[1]!;
      return {
        animationName: getComputedStyle(incoming).animationName,
        animationDuration: getComputedStyle(incoming).animationDuration,
        enterY: overlay.style.getPropertyValue('--bdf-custom-enter-y'),
        enterScale: overlay.style.getPropertyValue('--bdf-custom-enter-scale'),
        easing: overlay.style.getPropertyValue('--bdf-screen-transition-easing'),
      };
    });
    expect(forward).toEqual({
      animationName: 'bdf-custom-in',
      animationDuration: '0.64s',
      enterY: '40px',
      enterScale: '0.9',
      easing: 'linear',
    });
    await expect(host.getByRole('heading', { name: 'Custom motion details' })).toBeVisible();

    await host.getByRole('button', { name: 'Back' }).click();
    await expect
      .poll(() =>
        host.evaluate(element => {
          const overlay = element.shadowRoot!.querySelector<HTMLElement>('.bdv-overlay')!;
          return [
            overlay.style.getPropertyValue('--bdf-custom-enter-x'),
            overlay.style.getPropertyValue('--bdf-custom-exit-x'),
          ];
        })
      )
      .toEqual(['-30px', '50px']);
    await expect(host.getByRole('heading', { name: 'Custom motion introduction' })).toBeVisible();
  });

  test('registerFlow remains interactive inside Radix-style host dismissal and focus traps', async ({
    page,
  }) => {
    await ready(page);
    await page.evaluate(() => {
      const hostDialog = document.createElement('div');
      hostDialog.id = 'flow-host-dialog';
      hostDialog.tabIndex = -1;
      document.body.appendChild(hostDialog);
      hostDialog.focus();
      const state = window as Window & {
        __flowHostDismissed?: boolean;
        __flowHostDismissEvents?: string[];
      };
      state.__flowHostDismissed = false;
      state.__flowHostDismissEvents = [];
      document.addEventListener(
        'pointerdown',
        event => {
          const owned = document.querySelector('[data-bugdrop-flow="radix-flow-proof"]');
          if (!owned || !event.composedPath().includes(owned)) return;
          for (const eventType of [
            'dismissableLayer.pointerDownOutside',
            'dismissableLayer.interactOutside',
          ]) {
            const outside = new CustomEvent(eventType, {
              bubbles: true,
              cancelable: true,
              composed: true,
              detail: { originalEvent: event },
            });
            state.__flowHostDismissEvents?.push(eventType);
            document.dispatchEvent(outside);
            if (!outside.defaultPrevented) state.__flowHostDismissed = true;
          }
        },
        true
      );
      document.addEventListener(
        'focusin',
        event => {
          const owned = document.querySelector('[data-bugdrop-flow="radix-flow-proof"]');
          if (owned && event.composedPath().includes(owned)) hostDialog.focus();
        },
        true
      );
    });
    const config: FlowConfig = {
      configVersion: 1,
      id: 'radix-flow-proof',
      presentation: { kind: 'modal' },
      forms: [
        {
          id: 'answer',
          title: 'Radix Flow proof',
          fields: [{ id: 'detail', type: 'longText', label: 'Your answer', required: true }],
        },
      ],
      screens: [{ id: 'answer-screen', type: 'form', form: 'answer' }],
      issue: { title: 'Radix Flow proof' },
    };
    const host = await openConfig(page, config);
    const answer = host.getByRole('textbox', { name: 'Your answer' });

    await answer.click();
    await answer.fill('OpenStack');
    await expect(answer).toHaveValue('OpenStack');
    await expect(answer).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __flowHostDismissEvents?: string[] }).__flowHostDismissEvents
        )
      )
      .toEqual(['dismissableLayer.pointerDownOutside', 'dismissableLayer.interactOutside']);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __flowHostDismissed?: boolean }).__flowHostDismissed
        )
      )
      .toBe(false);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .not.toBe('flow-host-dialog');
  });

  test('product-triage completes its natural composable journey', async ({ page }) => {
    const payloads = await mockFeedback(page, 52);
    await ready(page);
    const host = await openRecipe(page, 'product-triage');
    const root = host.locator('.bdv-root');
    await expect(root).toHaveAttribute('data-size', 'wide');
    await expect(root).toHaveAttribute('data-columns', '2');
    await expect(root).toHaveAttribute('data-density', 'compact');
    await expect(root).toHaveClass(/bdv-dark/);
    expect(await root.evaluate(element => element.style.getPropertyValue('--bdv-accent'))).toBe(
      '#f97316'
    );

    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByLabel('Bug').click();
    await host.getByRole('radio', { name: '2 stars' }).click();
    await host.getByLabel('Summary').fill('Checkout stalls');
    await expect(host.getByText('Step 2 of 4')).toBeVisible();
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByLabel('What happened?').fill('Spinner never stops');
    await host.getByLabel('Chromium').click();
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByRole('button', { name: 'Back' }).click();
    await expect(host.getByLabel('What happened?')).toHaveValue('Spinner never stops');
    await expect(host.getByLabel('Chromium')).toBeChecked();
    await host.getByRole('button', { name: 'Back' }).click();
    await expect(host.getByLabel('Summary')).toHaveValue('Checkout stalls');
    await expect(host.getByRole('radio', { name: '2 stars' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await host.getByRole('radio', { name: '4 stars' }).click();
    await host.getByRole('button', { name: 'Continue' }).click();
    await expect(host.getByText('Step 3 of 3')).toBeVisible();
    await host.getByLabel('Include a screenshot').uncheck();
    await host.getByRole('button', { name: 'Submit' }).click();
    await expect(host.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      title: 'Triage: Checkout stalls',
      category: 'feature',
      screenshot: null,
      attachments: [],
      description: '## Type\n\nBug\n\n## Experience\n\n★★★★☆ (4/5)',
    });
    expect(payloads[0].description).not.toContain('Spinner never stops');
  });

  test('customer-pulse completes its natural composable journey', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const payloads = await mockFeedback(page, 53, true);
    await ready(page);
    const host = await openRecipe(page, 'customer-pulse');
    const root = host.locator('.bdv-root');
    await expect(root).toHaveAttribute('data-size', 'compact');
    await expect(root).toHaveAttribute('data-columns', '1');
    await expect(root).toHaveAttribute('data-density', 'comfortable');
    await expect(root).toHaveClass(/bdv-dark/);
    expect((await host.boundingBox())?.width).toBeLessThanOrEqual(390);

    const scoreGroup = host.getByRole('radiogroup', { name: 'Ease score' });
    const scoreControls = scoreGroup.getByRole('radio');
    await expect(scoreControls).toHaveCount(10);
    expect(await scoreControls.allTextContents()).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
    ]);
    await expect(host.getByText('Difficult', { exact: true })).toBeVisible();
    await expect(host.getByText('Easy', { exact: true })).toBeVisible();

    await host.getByRole('radio', { name: '3 stars' }).click();
    await host.getByRole('button', { name: 'Continue' }).click();
    await expect(host.getByRole('button', { name: 'Change score' })).toBeVisible();
    await host.getByRole('button', { name: 'Change score' }).click();
    await expect(host.getByRole('radio', { name: '3 stars' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByLabel('What made this difficult?').fill('Invoice filters reset');
    await host.getByLabel('Yes').click();
    await host.getByLabel('I consent to a product follow-up').check();
    await host.getByRole('button', { name: 'Send pulse' }).click();
    await expect(host.getByText('Temporary failure')).toBeVisible();
    await expect(host.getByRole('button', { name: 'Not now' })).toBeVisible();
    await host.getByRole('button', { name: 'Try again' }).click();
    await expect(host.getByRole('heading', { name: 'Pulse recorded' })).toBeVisible();
    await expect(host.getByText('Thanks for sharing how billing feels today.')).toBeVisible();

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual(
      expect.objectContaining({
        title: 'Billing pulse 3/10',
        category: 'question',
        screenshot: null,
        attachments: [],
        description:
          '## Score\n\n3\n\n## Follow-up\n\nInvoice filters reset\n\n## Contact\n\nYes\n\n## Consent\n\ntrue',
      })
    );
  });

  test('auto screenshot captures once without showing chooser or annotation', async ({ page }) => {
    const payloads = await mockFeedback(page, 54);
    await ready(page, true);
    const config: FlowConfig = {
      configVersion: 1,
      id: 'auto-capture-proof',
      presentation: { kind: 'modal' },
      forms: [
        {
          id: 'report',
          title: 'Automatic evidence',
          fields: [{ id: 'summary', type: 'shortText', label: 'Summary', required: true }],
        },
      ],
      screens: [
        { id: 'report-screen', type: 'form', form: 'report' },
        { id: 'capture', type: 'screenshot', mode: 'auto' },
      ],
      issue: { title: '{{report.summary}}' },
    };
    const host = await openConfig(page, config);
    await host.getByLabel('Summary').fill('Automatic proof');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByRole('button', { name: 'Submit' }).click();
    await expect(host.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
    await expect(page.locator('#bugdrop-host [data-action="capture"]')).toHaveCount(0);
    await expect(page.locator('#bugdrop-host #annotation-canvas')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as Window & { __captureCount?: number }).__captureCount)
    ).toBe(1);
    expect(payloads[0]).toMatchObject({ title: 'Automatic proof', screenshot: stubPng });
  });

  test('area and element capture return to the same Flow dialog', async ({ page }) => {
    const payloads = await mockFeedback(page, 57);
    await ready(page, true);
    const host = await openRecipe(page, 'product-triage');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByLabel('Bug').click();
    await host.getByRole('radio', { name: '4 stars' }).click();
    await host.getByLabel('Summary').fill('Selection capture');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByRole('button', { name: 'Submit' }).click();

    const capture = host.locator('[data-flow-capture="true"]');
    await capture.locator('[data-action="area"]').click();
    await expect(page.locator('#bugdrop-area-picker-overlay')).toBeVisible();
    await page.mouse.move(200, 200);
    await page.mouse.down();
    await page.mouse.move(420, 340);
    await page.mouse.up();
    await expect(capture.locator('#annotation-canvas canvas')).toBeVisible();
    await capture.locator('[data-action="retake"]').click();

    await expect(capture.getByRole('heading', { name: 'Capture Screenshot' })).toBeVisible();
    await capture.locator('[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-overlay')).toBeVisible();
    await page.mouse.click(250, 60);
    await expect(capture.locator('#annotation-canvas canvas')).toBeVisible();
    await capture.locator('[data-action="done"]').click();
    await expect(host.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
    expect(payloads).toHaveLength(1);
    expectValidPngDataUrl(payloads[0]?.screenshot);
    expect(payloads[0]?.metadata.elementSelector).toBeTruthy();
  });

  test('Flow capture stays usable on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockFeedback(page, 58);
    await ready(page, true);
    const host = await openRecipe(page, 'product-triage');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByLabel('Bug').click();
    await host.getByRole('radio', { name: '4 stars' }).click();
    await host.getByLabel('Summary').fill('Mobile capture');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByRole('button', { name: 'Submit' }).click();

    const capture = host.locator('[data-flow-capture="true"]');
    await expect(capture.getByRole('heading', { name: 'Capture Screenshot' })).toBeVisible();
    await capture.locator('[data-action="capture"]').click();
    await expect(capture.locator('#annotation-canvas canvas')).toBeVisible();
    await expect(capture.locator('[data-action="review"]')).toBeInViewport();
    await capture.locator('[data-action="review"]').click();
    await expect(capture.locator('[data-action="send-reviewed"]')).toBeInViewport();
    await capture.locator('[data-action="send-reviewed"]').click();
    await expect(host.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
  });

  test('Flow capture colors ignore classic widget overrides', async ({ page }) => {
    await page.route('**/test/welcome-disabled.html*', async route => {
      const response = await route.fetch();
      const body = await response.text();
      const original = "dataset: { theme: 'dark', welcome: 'false' }";
      expect(body).toContain(original);
      await route.fulfill({
        response,
        body: body.replace(
          original,
          "dataset: { theme: 'light', bg: '#ffffff', text: '#111111', welcome: 'false' }"
        ),
      });
    });
    await mockFeedback(page, 59);
    await ready(page);
    const host = await openRecipe(page, 'product-triage');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByLabel('Bug').click();
    await host.getByRole('radio', { name: '4 stars' }).click();
    await host.getByLabel('Summary').fill('Theme contrast');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByRole('button', { name: 'Submit' }).click();

    const capture = host.locator('[data-flow-capture="true"]');
    await expect(capture.getByRole('heading', { name: 'Capture Screenshot' })).toBeVisible();
    expect(
      await capture
        .locator('.bd-modal')
        .evaluate(element => getComputedStyle(element).backgroundColor)
    ).toBe('rgb(15, 23, 42)');
    expect(
      await capture.locator('.bd-title').evaluate(element => getComputedStyle(element).color)
    ).toBe('rgb(248, 250, 252)');
    expect(
      await capture.locator('.bd-btn-primary').evaluate(element => getComputedStyle(element).color)
    ).toBe('rgb(255, 255, 255)');
  });

  test('final screenshot shows submission progress while the request is pending', async ({
    page,
  }) => {
    let releaseRequest = () => {};
    const requestGate = new Promise<void>(resolve => {
      releaseRequest = resolve;
    });
    await page.route('**/api/feedback', async route => {
      await requestGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          issueNumber: 60,
          issueUrl: 'https://github.com/mean-weasel/bugdrop-widget-test/issues/60',
          isPublic: false,
        }),
      });
    });
    await ready(page, true);
    const host = await openRecipe(page, 'product-triage');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByLabel('Bug').click();
    await host.getByRole('radio', { name: '4 stars' }).click();
    await host.getByLabel('Summary').fill('Pending submission');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByRole('button', { name: 'Submit' }).click();
    const capture = host.locator('[data-flow-capture="true"]');
    await capture.locator('[data-action="capture"]').click();
    await capture.locator('[data-action="done"]').click();
    try {
      await expect(host.getByRole('heading', { name: 'Submitting feedback' })).toBeVisible();
    } finally {
      releaseRequest();
    }
    await expect(host.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
  });

  test('close tears down an in-progress screenshot chooser', async ({ page }) => {
    await mockFeedback(page, 55);
    await ready(page);
    await page.evaluate(() => {
      const opener = document.createElement('button');
      opener.id = 'flow-opener';
      opener.textContent = 'Open feedback';
      document.body.appendChild(opener);
      opener.focus();
    });
    const host = await openRecipe(page, 'product-triage');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByLabel('Bug').click();
    await host.getByRole('radio', { name: '4 stars' }).click();
    await host.getByLabel('Summary').fill('Close capture');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByRole('button', { name: 'Submit' }).click();
    const chooser = host.locator('[data-flow-capture="true"] .bd-overlay');
    await expect(chooser.getByRole('heading', { name: 'Capture Screenshot' })).toBeVisible();
    await page.evaluate(() =>
      (window as Window & { __publicFlow?: { close(): void } }).__publicFlow?.close()
    );
    await expect(host).toHaveCount(0);
    await expect(chooser).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
    await expect(page.locator('#flow-opener')).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __publicFlow?: { result: Promise<unknown> } }).__publicFlow
              ?.result
        )
      )
      .toEqual({ status: 'closed' });
  });

  test('returning from screenshot selection restores focus to the flow', async ({ page }) => {
    await mockFeedback(page, 56);
    await ready(page);
    const host = await openRecipe(page, 'product-triage');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByLabel('Bug').click();
    await host.getByRole('radio', { name: '4 stars' }).click();
    await host.getByLabel('Summary').fill('Return focus');
    await host.getByRole('button', { name: 'Continue' }).click();
    await host.getByRole('button', { name: 'Submit' }).click();
    const chooser = host.locator('[data-flow-capture="true"] .bd-overlay');
    await expect(chooser.getByRole('heading', { name: 'Capture Screenshot' })).toBeVisible();
    await chooser.locator('.bd-close').click();
    await expect(chooser).toHaveCount(0);
    await expect(host.getByRole('dialog')).toBeVisible();
    await expect(host.getByRole('dialog').getByRole('button').first()).toBeFocused();
  });
});
