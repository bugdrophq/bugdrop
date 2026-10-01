import { writeFile } from 'node:fs/promises';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  assertExactPreviewWidgetResponse,
  installExactPreviewWidgetFromEnvironment,
  test,
  waitForPreviewWidgetResponse,
} from './live-preview-widget';
import { isExpectedLiveConsoleError } from './live-console-errors';

/**
 * Live E2E tests for BugDrop widget on a real cross-origin deployment.
 *
 * These tests run against the Vercel preview of bugdrop-widget-test,
 * which loads the widget from the CF Workers preview deployment.
 * They validate cross-origin behavior that local tests cannot cover.
 *
 * Run with: LIVE_TARGET=preview PLAYWRIGHT_BASE_URL=<vercel-url> npx playwright test --project=chromium-live
 */

// Add Vercel deployment protection bypass headers only to Vercel requests
// (not globally, which would cause CORS preflight failures on cross-origin APIs)
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const expectedWidgetOrigin =
  process.env.EXPECTED_WIDGET_ORIGIN ||
  (process.env.LIVE_TARGET === 'preview'
    ? 'https://bugdrop-preview.neonwatty.workers.dev'
    : process.env.LIVE_TARGET
      ? 'https://bugdrop.neonwatty.workers.dev'
      : undefined);
const expectedWidgetSha256 = process.env.EXPECTED_WIDGET_SHA256;
const venuePath = process.env.LIVE_VENUE_PATH || '/';

if (bypassSecret) {
  test.beforeEach(async ({ context }) => {
    await context.route('**/*.vercel.app/**', async route => {
      const headers = {
        ...route.request().headers(),
        'x-vercel-protection-bypass': bypassSecret,
      };
      await route.continue({ headers });
    });
  });
}

async function mockInstalledRepo(page: Page) {
  await page.route('**/api/check/**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ installed: true }),
    });
  });
}

async function loadDeployedWidgetFixture(
  page: Page,
  dataset: Record<string, string>,
  options: { fixturePath?: string; bodyStyle?: string } = {}
) {
  const widgetOrigin = expectedWidgetOrigin || 'https://bugdrop-preview.neonwatty.workers.dev';
  const fixturePath = options.fixturePath ?? '/bugdrop-live-locale-fixture';
  const dataAttributes = Object.entries(dataset)
    .map(([key, value]) => `data-${key}="${value}"`)
    .join('\n          ');

  await page.route(`**${fixturePath}`, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `
        <!doctype html>
        <html lang="en-US">
          <head><title>BugDrop live fixture</title></head>
          <body style="${options.bodyStyle ?? ''}">
            <main>
              <h1>BugDrop live fixture</h1>
              <p>Fixture page for deployed widget smoke tests.</p>
            </main>
            <script
              src="${widgetOrigin}/widget.js"
              data-repo="mean-weasel/bugdrop-widget-test"
              ${dataAttributes}
            ></script>
          </body>
        </html>
      `,
    });
  });

  await page.goto(fixturePath);
}

async function brandedAppearance(page: Page) {
  return page.evaluate(() => {
    const shadow = document.querySelector('#bugdrop-host')?.shadowRoot;
    const root = shadow?.querySelector('.bd-root');
    const trigger = shadow?.querySelector('.bd-trigger');
    const modal = shadow?.querySelector('.bd-modal');
    const title = shadow?.querySelector('.bd-title');
    const primaryButton = shadow?.querySelector('.bd-btn-primary');
    if (!(root && trigger)) throw new Error('Expected branded widget root and trigger');

    const rootStyle = getComputedStyle(root);
    const triggerStyle = getComputedStyle(trigger);
    const modalStyle = modal ? getComputedStyle(modal) : null;
    const titleStyle = title ? getComputedStyle(title) : null;
    const buttonStyle = primaryButton ? getComputedStyle(primaryButton) : null;
    return {
      dark: root.classList.contains('bd-dark'),
      variables: {
        font: rootStyle.getPropertyValue('--bd-font').trim(),
        primary: rootStyle.getPropertyValue('--bd-primary').trim(),
        background: rootStyle.getPropertyValue('--bd-bg-primary').trim(),
        text: rootStyle.getPropertyValue('--bd-text-primary').trim(),
        borderWidth: rootStyle.getPropertyValue('--bd-border-width').trim(),
        border: rootStyle.getPropertyValue('--bd-border').trim(),
        shadow: rootStyle.getPropertyValue('--bd-shadow-lg').trim(),
      },
      trigger: {
        background: triggerStyle.backgroundColor,
        color: triggerStyle.color,
        font: triggerStyle.fontFamily,
        borderWidth: triggerStyle.borderTopWidth,
        borderColor: triggerStyle.borderTopColor,
        leftRadius: triggerStyle.borderTopLeftRadius,
        rightRadius: triggerStyle.borderTopRightRadius,
      },
      modal: modalStyle
        ? {
            background: modalStyle.backgroundColor,
            borderWidth: modalStyle.borderTopWidth,
            borderColor: modalStyle.borderTopColor,
            radius: modalStyle.borderTopLeftRadius,
            shadow: modalStyle.boxShadow,
          }
        : null,
      titleColor: titleStyle?.color ?? null,
      primaryButtonBackground: buttonStyle?.backgroundColor ?? null,
    };
  });
}

function expectBrandedAppearance(
  appearance: Awaited<ReturnType<typeof brandedAppearance>>,
  options: { modal: boolean; fontVariable?: string; triggerFont?: string }
) {
  expect(appearance.variables).toEqual({
    font: options.fontVariable ?? 'monospace, system-ui, sans-serif',
    primary: '#b91c1c',
    background: '#fef3c7',
    text: '#422006',
    borderWidth: '3px',
    border: '#7c2d12',
    shadow: '#7c2d12 calc(3px + 2px) calc(3px + 2px) 0 0',
  });
  expect(appearance.trigger).toEqual({
    background: 'rgb(185, 28, 28)',
    color: appearance.dark ? 'rgb(15, 23, 42)' : 'rgb(255, 255, 255)',
    font: options.triggerFont ?? 'monospace, system-ui, sans-serif',
    borderWidth: '3px',
    borderColor: 'rgb(124, 45, 18)',
    leftRadius: '0px',
    rightRadius: '8px',
  });
  if (!options.modal) {
    expect(appearance.modal).toBeNull();
    return;
  }
  const { shadow: _shadow, ...modal } = appearance.modal;
  expect(modal).toEqual({
    background: 'rgb(254, 243, 199)',
    borderWidth: '3px',
    borderColor: 'rgb(124, 45, 18)',
    radius: '8px',
  });
  expect(appearance.titleColor).toBe('rgb(66, 32, 6)');
  expect(appearance.primaryButtonBackground).toBe('rgb(185, 28, 28)');
}

async function addCorsBlockedImage(page: Page) {
  await page.route('https://third-party.test/no-cors-badge.svg', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="44"><rect width="180" height="44" fill="#14b8a6"/><text x="16" y="28" fill="white" font-size="16">No CORS Badge</text></svg>',
    });
  });

  await page.evaluate(() => {
    const img = document.createElement('img');
    img.alt = 'Third-party badge without CORS headers';
    img.src = 'https://third-party.test/no-cors-badge.svg';
    img.style.display = 'block';
    img.style.margin = '24px';
    document.body.prepend(img);
  });
}

async function openScreenshotOptions(page: Page, title: string) {
  await mockInstalledRepo(page);
  await page.goto(venuePath);

  const host = page.locator('#bugdrop-host');
  const button = host.locator('css=.bd-trigger');
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();

  const getStartedBtn = host.locator('css=[data-action="continue"]');
  await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
  await getStartedBtn.click();

  const titleInput = host.locator('css=#title');
  await expect(titleInput).toBeVisible({ timeout: 5_000 });
  await titleInput.fill(title);

  const screenshotCheckbox = host.locator('css=#include-screenshot');
  await screenshotCheckbox.check();

  await host.locator('css=#submit-btn').click();
  return host;
}

async function trackLiveFeedbackPayloads(page: Page) {
  const payloads: Array<Record<string, unknown>> = [];
  await page.route('**/feedback', async route => {
    payloads.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
    });
  });
  return payloads;
}

async function clearTriggerPositionStorage(page: Page) {
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter(key => key.startsWith('bugdrop_trigger_position_'))
      .forEach(key => localStorage.removeItem(key));
  });
}

async function dragTriggerHandle(page: Page, deltaY: number) {
  const handle = page.locator('#bugdrop-host').locator('css=.bd-trigger-drag-handle');
  await expect(handle).toBeVisible({ timeout: 10_000 });

  const handleBox = await handle.boundingBox();
  expect(handleBox).not.toBeNull();

  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2,
    handleBox!.y + handleBox!.height / 2 + deltaY,
    { steps: 8 }
  );
  await page.mouse.up();
}

async function countRedPixelsInRegion(
  canvas: Locator,
  region: { left: number; top: number; right: number; bottom: number }
) {
  return canvas.evaluate((el, targetRegion) => {
    const source = el as HTMLCanvasElement;
    const ctx = source.getContext('2d');
    if (!ctx) {
      throw new Error('Missing canvas context');
    }

    const xStart = Math.floor(source.width * targetRegion.left);
    const xEnd = Math.ceil(source.width * targetRegion.right);
    const yStart = Math.floor(source.height * targetRegion.top);
    const yEnd = Math.ceil(source.height * targetRegion.bottom);
    const { data, width } = ctx.getImageData(xStart, yStart, xEnd - xStart, yEnd - yStart);
    let red = 0;

    for (let y = 0; y < yEnd - yStart; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        if (a > 200 && r > 220 && g < 80 && b < 80) {
          red++;
        }
      }
    }

    return red;
  }, region);
}

async function countBlackPixelsInRegion(
  canvas: Locator,
  region: { left: number; top: number; right: number; bottom: number }
) {
  return canvas.evaluate((el, targetRegion) => {
    const source = el as HTMLCanvasElement;
    const ctx = source.getContext('2d');
    if (!ctx) {
      throw new Error('Missing canvas context');
    }

    const xStart = Math.floor(source.width * targetRegion.left);
    const xEnd = Math.ceil(source.width * targetRegion.right);
    const yStart = Math.floor(source.height * targetRegion.top);
    const yEnd = Math.ceil(source.height * targetRegion.bottom);
    const { data, width } = ctx.getImageData(xStart, yStart, xEnd - xStart, yEnd - yStart);
    let black = 0;

    for (let y = 0; y < yEnd - yStart; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        if (a > 200 && r < 20 && g < 20 && b < 20) {
          black++;
        }
      }
    }

    return black;
  }, region);
}

async function countBlackPixelsInDataUrl(
  page: Page,
  dataUrl: string,
  region: { left: number; top: number; right: number; bottom: number }
) {
  return page.evaluate(
    async target => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load screenshot payload'));
        img.src = target.dataUrl;
      });

      const source = document.createElement('canvas');
      source.width = img.width;
      source.height = img.height;
      const ctx = source.getContext('2d');
      if (!ctx) {
        throw new Error('Missing canvas context');
      }

      ctx.drawImage(img, 0, 0);

      const xStart = Math.floor(source.width * target.region.left);
      const xEnd = Math.ceil(source.width * target.region.right);
      const yStart = Math.floor(source.height * target.region.top);
      const yEnd = Math.ceil(source.height * target.region.bottom);
      const { data, width } = ctx.getImageData(xStart, yStart, xEnd - xStart, yEnd - yStart);
      let black = 0;

      for (let y = 0; y < yEnd - yStart; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];

          if (a > 200 && r < 20 && g < 20 && b < 20) {
            black++;
          }
        }
      }

      return black;
    },
    { dataUrl, region }
  );
}

async function dragOnCanvas(
  page: Page,
  canvas: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number }
) {
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  await page.mouse.move(box!.x + from.x * box!.width, box!.y + from.y * box!.height);
  await page.mouse.down();
  await page.mouse.move(box!.x + to.x * box!.width, box!.y + to.y * box!.height, {
    steps: 12,
  });
  await page.mouse.up();
}

async function visibleCanvasDragRange(canvas: Locator) {
  return canvas.evaluate(el => {
    const canvasBox = el.getBoundingClientRect();
    const stageBox = el.parentElement!.getBoundingClientRect();
    const top = Math.max(canvasBox.top, stageBox.top, 0) + 24;
    const bottom = Math.min(canvasBox.bottom, stageBox.bottom, window.innerHeight) - 24;
    if (bottom - top < 80) {
      throw new Error('Not enough visible canvas height for a drag');
    }
    return {
      fromY: (top + (bottom - top) * 0.2 - canvasBox.top) / canvasBox.height,
      toY: (top + (bottom - top) * 0.7 - canvasBox.top) / canvasBox.height,
    };
  });
}

async function expectUsableCanvas(canvas: Locator) {
  await expect
    .poll(() => canvas.evaluate(el => (el as HTMLCanvasElement).width))
    .toBeGreaterThan(0);
  await expect
    .poll(() => canvas.evaluate(el => (el as HTMLCanvasElement).height))
    .toBeGreaterThan(0);
}

test.describe('Widget Loading (Live)', () => {
  test('widget loads and renders on cross-origin site', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('BugDrop')) {
        errors.push(msg.text());
      }
    });

    await page.goto(venuePath);
    await page.waitForTimeout(2000);

    // Widget host element should exist
    const host = page.locator('#bugdrop-host');
    await expect(host).toBeAttached({ timeout: 10_000 });

    // Feedback button should be visible in shadow DOM
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });

    // No unexpected console errors (filter out CORS font errors and known benign messages)
    const unexpectedErrors = errors.filter(error => !isExpectedLiveConsoleError(error));
    expect(unexpectedErrors).toHaveLength(0);
  });

  test('venue loads the expected deployed widget asset', async ({ page }) => {
    const responsePromise = expectedWidgetOrigin
      ? waitForPreviewWidgetResponse(page, expectedWidgetOrigin)
      : undefined;
    await page.goto(venuePath);

    const widgetSrc = await page.evaluate(() => {
      return (
        Array.from(document.scripts)
          .map(script => script.src)
          .find(src => src.includes('/widget.js')) || ''
      );
    });

    if (expectedWidgetOrigin) {
      expect(widgetSrc).toContain(`${expectedWidgetOrigin}/widget.js`);
    }

    if (responsePromise && expectedWidgetSha256) {
      await assertExactPreviewWidgetResponse(await responsePromise, expectedWidgetSha256);
    }
  });
});

test.describe('Localization (Live)', () => {
  test('deployed widget asset honors data-locale from the script tag', async ({ page }) => {
    await mockInstalledRepo(page);
    await loadDeployedWidgetFixture(page, { locale: 'pl' });

    const host = page.locator('#bugdrop-host');
    const trigger = host.locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await expect(trigger.locator('css=.bd-trigger-label')).toHaveText('Opinia');
    await expect(trigger).toHaveAttribute('aria-label', 'Zgłoś błąd lub wyślij opinię');

    await trigger.click();
    await expect(host.locator('css=.bd-title')).toHaveText('Podziel się opinią');
    await expect(host.locator('css=[data-action="continue"]')).toHaveText('Rozpocznij');
  });
});

test.describe('Feedback Button (Live)', () => {
  test('preserves configured styling across the exact default-flow artifact', async ({ page }) => {
    const appearances: Array<{
      state: string;
      appearance: Awaited<ReturnType<typeof brandedAppearance>>;
    }> = [];
    const recordAppearance = async (state: string, modal: boolean) => {
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      const appearance = await brandedAppearance(page);
      expectBrandedAppearance(appearance, { modal });
      appearances.push({ state, appearance });
    };
    await mockInstalledRepo(page);
    let attempts = 0;
    await page.route('**/feedback', async route => {
      attempts += 1;
      await route.fulfill({
        status: attempts === 1 ? 500 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          attempts === 1
            ? { success: false, error: 'Deliberate branded retry' }
            : { success: true, issueNumber: 1, issueUrl: '#', isPublic: false }
        ),
      });
    });
    const brandedDataset = {
      theme: 'light',
      position: 'bottom-left',
      color: '#b91c1c',
      font: 'monospace',
      radius: '4',
      bg: '#fef3c7',
      text: '#422006',
      'border-width': '3',
      'border-color': '#7c2d12',
      shadow: 'hard',
      icon: 'none',
      label: 'Brand feedback',
    };
    await loadDeployedWidgetFixture(page, brandedDataset);

    const host = page.locator('#bugdrop-host');
    const trigger = host.locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await expect(trigger.locator('css=.bd-trigger-label')).toHaveText('Brand feedback');
    await expect(trigger.locator('css=.bd-trigger-icon')).toHaveCount(0);
    await recordAppearance('trigger-light', false);

    await page.evaluate(() => window.BugDrop?.setTheme('dark'));
    await expect.poll(async () => (await brandedAppearance(page)).dark).toBe(true);
    await recordAppearance('trigger-dark', false);
    await page.evaluate(() => window.BugDrop?.setTheme('light'));

    await trigger.click();
    await expect(host.locator('css=[data-action="continue"]')).toBeVisible();
    await recordAppearance('welcome', true);
    await host.locator('css=[data-action="continue"]').click();

    const title = host.locator('css=#title');
    await expect(title).toBeVisible();
    await host.locator('css=#submit-btn').click();
    await expect(title).toBeFocused();
    expect(await title.evaluate(element => element.matches(':invalid'))).toBe(true);
    await expect(title).toHaveCSS('border-top-color', 'rgb(185, 28, 28)');
    await recordAppearance('validation', true);

    await title.fill('Branded compatibility');
    await host.locator('css=#include-screenshot').uncheck();
    await host.locator('css=#submit-btn').click();
    await expect(host.locator('css=.bd-title')).toHaveText('Submission Failed');
    await expect(host.locator('css=.bd-error-message__text')).toHaveText(
      'Deliberate branded retry'
    );
    await recordAppearance('failure', true);

    await host.locator('css=[data-action="retry"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10_000 });
    expect(attempts).toBe(2);
    await recordAppearance('success', true);

    await loadDeployedWidgetFixture(
      page,
      { ...brandedDataset, font: 'inherit' },
      {
        fixturePath: '/bugdrop-live-inherited-font-fixture',
        bodyStyle: 'font-family: Georgia, serif',
      }
    );
    await expect(page.locator('#bugdrop-host').locator('css=.bd-trigger')).toBeVisible();
    const inheritedAppearance = await brandedAppearance(page);
    expectBrandedAppearance(inheritedAppearance, {
      modal: false,
      fontVariable: '',
      triggerFont: 'Georgia, serif',
    });
    appearances.push({ state: 'font-inherit', appearance: inheritedAppearance });

    const snapshotPath = process.env.BUGDROP_STYLE_SNAPSHOT_PATH?.trim();
    if (snapshotPath) await writeFile(snapshotPath, `${JSON.stringify(appearances, null, 2)}\n`);
  });

  test('feedback button is visible and clickable', async ({ page }) => {
    await page.goto(venuePath);

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });

    // Click should open the modal
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });
  });

  test('feedback button drag position persists on deployed preview widget', async ({ page }) => {
    await page.goto(venuePath);
    await clearTriggerPositionStorage(page);
    await page.reload();

    const host = page.locator('#bugdrop-host');
    const trigger = host.locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 10_000 });

    await dragTriggerHandle(page, -140);

    const draggedTop = await trigger.evaluate(el => el.getBoundingClientRect().top);
    const storedPosition = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('bugdrop_trigger_position_'));
      return key ? localStorage.getItem(key) : null;
    });

    expect(storedPosition).not.toBeNull();
    await expect(host.locator('css=.bd-modal')).not.toBeVisible();

    await page.reload();
    await expect(trigger).toBeVisible({ timeout: 10_000 });

    const restoredTop = await trigger.evaluate(el => el.getBoundingClientRect().top);
    expect(Math.abs(restoredTop - draggedTop)).toBeLessThanOrEqual(2);
  });
});

test.describe('Welcome Flow (Live)', () => {
  test('welcome screen shows on first visit', async ({ page }) => {
    await page.goto('/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Fresh Playwright context = first visit = welcome screen
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
  });

  test('can proceed past welcome screen to feedback form', async ({ page }) => {
    await page.goto('/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    // Click "Get Started" on welcome screen
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
    await getStartedBtn.click();

    // Feedback form should appear with title input
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Cross-Origin API (Live)', () => {
  test('widget derives API URL correctly from cross-origin script src', async ({ page }) => {
    // Register listener before navigation to capture all API calls
    const apiCalls: string[] = [];
    page.on('request', req => {
      if (req.url().includes('/api/')) {
        apiCalls.push(req.url());
      }
    });

    await page.goto('/');

    // Wait for widget to load
    const host = page.locator('#bugdrop-host');
    await expect(host).toBeAttached({ timeout: 10_000 });

    // Open the modal to trigger the installation check
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    // Wait for the API call to fire
    await page.waitForTimeout(3_000);

    // At least one API call should have been made
    expect(apiCalls.length).toBeGreaterThan(0);

    // All API calls should go to the expected worker origin (not the Vercel domain)
    for (const url of apiCalls) {
      expect(url).toContain(expectedWidgetOrigin || 'workers.dev');
    }
  });

  test('cross-origin API check succeeds (CORS configured)', async ({ page }) => {
    await page.goto('/');

    // Track API responses to verify cross-origin requests succeed
    const apiResponses: { url: string; status: number }[] = [];
    page.on('response', res => {
      if (res.url().includes('/api/check/')) {
        apiResponses.push({ url: res.url(), status: res.status() });
      }
    });

    // Open the modal to trigger the installation check API call
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    // Wait for the API response
    await page.waitForTimeout(3_000);

    // A successful cross-origin fetch proves CORS is configured correctly
    expect(apiResponses.length).toBeGreaterThan(0);
    expect(apiResponses[0].status).toBe(200);
  });
});

test.describe('Widget Attribution (Live)', () => {
  test('BugDrop version badge is visible in modal', async ({ page }) => {
    await page.goto('/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const version = page.locator('#bugdrop-host').locator('css=.bd-version');
    await expect(version).toBeVisible();
    await expect(version).toContainText('BugDrop');
  });
});

test.describe('Screenshot Capture (Live)', () => {
  test('screenshot option is available in cross-origin context', async ({ page }) => {
    // Mock the installation check to return installed: true
    await page.route('**/api/check/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    // Click "Get Started" on welcome screen
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
    await getStartedBtn.click();

    // Fill in feedback form
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await titleInput.fill('Live test feedback');

    // Screenshot checkbox should be available
    const screenshotCheckbox = page.locator('#bugdrop-host').locator('css=#include-screenshot');
    await expect(screenshotCheckbox).toBeVisible();
    await screenshotCheckbox.check();

    // Click Continue to get to screenshot options
    const continueBtn = page.locator('#bugdrop-host').locator('css=#submit-btn');
    await continueBtn.click();

    // Screenshot capture options should appear
    const fullPageBtn = page.locator('#bugdrop-host').locator('css=[data-action="capture"]');
    const elementBtn = page.locator('#bugdrop-host').locator('css=[data-action="element"]');

    // At least one screenshot option should be available
    const fullPageVisible = await fullPageBtn.isVisible().catch(() => false);
    const elementVisible = await elementBtn.isVisible().catch(() => false);
    expect(fullPageVisible || elementVisible).toBeTruthy();
  });

  test('select area button is available in screenshot options', async ({ page }) => {
    await page.route('**/api/check/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto(venuePath);

    const host = page.locator('#bugdrop-host');
    const button = host.locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    const getStartedBtn = host.locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
    await getStartedBtn.click();

    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await titleInput.fill('Live test feedback');

    const screenshotCheckbox = host.locator('css=#include-screenshot');
    await screenshotCheckbox.check();

    const continueBtn = host.locator('css=#submit-btn');
    await continueBtn.click();

    const areaBtn = host.locator('css=[data-action="area"]');
    await expect(areaBtn).toBeVisible({ timeout: 5_000 });
    await expect(areaBtn).toHaveText('Select Area');

    await areaBtn.click();

    const tooltip = page.locator('#bugdrop-area-picker-tooltip');
    await expect(tooltip).toBeVisible({ timeout: 5_000 });
    await expect(tooltip).toHaveText('Draw a selection around the area to capture (ESC to cancel)');
    await expect(page.locator('#bugdrop-area-picker-cancel')).not.toBeAttached();

    await page.keyboard.press('Escape');
    await expect(page.locator('#bugdrop-area-picker-overlay')).not.toBeVisible({ timeout: 3_000 });
  });

  test('selected-area capture works with touch input on deployed preview widget', async ({
    browser,
    browserName,
  }) => {
    test.skip(!process.env.LIVE_TARGET, 'Requires a deployed live widget target');
    test.skip(browserName !== 'chromium', 'CDP touch dispatch is Chromium-only');

    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    await installExactPreviewWidgetFromEnvironment(context);
    if (bypassSecret) {
      await context.route('**/*.vercel.app/**', async route => {
        const headers = {
          ...route.request().headers(),
          'x-vercel-protection-bypass': bypassSecret,
        };
        await route.continue({ headers });
      });
    }
    const page = await context.newPage();

    try {
      const host = await openScreenshotOptions(page, 'Live mobile area capture');
      const areaBtn = host.locator('css=[data-action="area"]');
      await expect(areaBtn).toBeVisible({ timeout: 5_000 });
      await areaBtn.click();

      const overlay = page.locator('#bugdrop-area-picker-overlay');
      await expect(overlay).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#bugdrop-area-picker-cancel')).toHaveText('Cancel');

      const client = await context.newCDPSession(page);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: 40, y: 170, radiusX: 1, radiusY: 1, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: 280, y: 430, radiusX: 1, radiusY: 1, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await client.detach();

      await expect(overlay).not.toBeVisible({ timeout: 5_000 });
      await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30_000 });
    } finally {
      await context.close();
    }
  });

  test('full-page capture reaches annotation with a third-party no-CORS image', async ({
    page,
  }) => {
    const host = await openScreenshotOptions(page, 'Live preview no-CORS capture');
    await addCorsBlockedImage(page);

    const captureBtn = host.locator('css=[data-action="capture"]');
    await expect(captureBtn).toBeVisible({ timeout: 5_000 });
    await captureBtn.click();

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30_000 });
    await expect(host.locator('css=.bd-error-message__text')).not.toBeAttached();
  });

  test('annotation undo works on the deployed preview widget', async ({ page }) => {
    const host = await openScreenshotOptions(page, 'Live preview annotation undo');

    const captureBtn = host.locator('css=[data-action="capture"]');
    await expect(captureBtn).toBeVisible({ timeout: 5_000 });
    await captureBtn.click();

    const canvas = host.locator('css=#annotation-canvas canvas');
    await expect(host.locator('css=.bd-modal--annotator')).toBeVisible({ timeout: 10_000 });
    await expect(canvas).toBeVisible({ timeout: 10_000 });
    await expectUsableCanvas(canvas);

    const { fromY, toY } = await visibleCanvasDragRange(canvas);
    const firstRegion = { left: 0.1, top: fromY, right: 0.48, bottom: toY };
    const latestRegion = { left: 0.52, top: fromY, right: 0.9, bottom: toY };
    const firstBaseline = await countRedPixelsInRegion(canvas, firstRegion);
    const latestBaseline = await countRedPixelsInRegion(canvas, latestRegion);

    await dragOnCanvas(page, canvas, { x: 0.18, y: fromY }, { x: 0.42, y: toY });
    await dragOnCanvas(page, canvas, { x: 0.58, y: fromY }, { x: 0.82, y: toY });

    expect(await countRedPixelsInRegion(canvas, firstRegion)).toBeGreaterThan(firstBaseline + 20);
    expect(await countRedPixelsInRegion(canvas, latestRegion)).toBeGreaterThan(latestBaseline + 20);

    await host.locator('css=[data-action="undo"]').click();

    expect(await countRedPixelsInRegion(canvas, firstRegion)).toBeGreaterThan(firstBaseline + 20);
    await expect
      .poll(() => countRedPixelsInRegion(canvas, latestRegion))
      .toBeLessThanOrEqual(latestBaseline + 10);
  });

  test('redaction works on the deployed preview widget', async ({ page }) => {
    const payloads = await trackLiveFeedbackPayloads(page);
    const host = await openScreenshotOptions(page, 'Live preview redaction');

    const captureBtn = host.locator('css=[data-action="capture"]');
    await expect(captureBtn).toBeVisible({ timeout: 5_000 });
    await captureBtn.click();

    const canvas = host.locator('css=#annotation-canvas canvas');
    await expect(host.locator('css=.bd-modal--annotator')).toBeVisible({ timeout: 10_000 });
    await expect(canvas).toBeVisible({ timeout: 10_000 });
    await expectUsableCanvas(canvas);

    await host.locator('css=[data-tool="redact"]').click();
    const { fromY, toY } = await visibleCanvasDragRange(canvas);
    await dragOnCanvas(page, canvas, { x: 0.18, y: fromY }, { x: 0.42, y: toY });
    await dragOnCanvas(page, canvas, { x: 0.58, y: fromY }, { x: 0.82, y: toY });

    const firstRegion = { left: 0.1, top: fromY, right: 0.48, bottom: toY };
    const latestRegion = { left: 0.52, top: fromY, right: 0.9, bottom: toY };

    expect(await countBlackPixelsInRegion(canvas, firstRegion)).toBeGreaterThan(1000);
    expect(await countBlackPixelsInRegion(canvas, latestRegion)).toBeGreaterThan(1000);

    await host.locator('css=[data-action="undo"]').click();

    expect(await countBlackPixelsInRegion(canvas, firstRegion)).toBeGreaterThan(1000);
    expect(await countBlackPixelsInRegion(canvas, latestRegion)).toBeLessThan(20);

    await host.locator('css=[data-action="done"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10_000 });

    expect(payloads).toHaveLength(1);
    const submittedScreenshot = payloads[0].screenshot;
    expect(typeof submittedScreenshot).toBe('string');
    expect(
      await countBlackPixelsInDataUrl(page, submittedScreenshot as string, firstRegion)
    ).toBeGreaterThan(1000);
    expect(
      await countBlackPixelsInDataUrl(page, submittedScreenshot as string, latestRegion)
    ).toBeLessThan(20);
  });

  test('privacy masking failure UX works on the deployed production widget', async ({ page }) => {
    test.skip(
      process.env.LIVE_TARGET !== 'production',
      'The production failure fixture is hosted on the production Vercel venue.'
    );

    await mockInstalledRepo(page);
    const payloads = await trackLiveFeedbackPayloads(page);
    await page.goto('/redaction-failure.html');

    const host = page.locator('#bugdrop-host');
    await expect(host.locator('css=.bd-trigger')).toBeVisible({ timeout: 10_000 });
    await host.locator('css=.bd-trigger').click();

    await expect(host.locator('css=[data-action="continue"]')).toBeVisible({ timeout: 5_000 });
    await host.locator('css=[data-action="continue"]').click();

    await expect(host.locator('css=#title')).toBeVisible({ timeout: 5_000 });
    await host.locator('css=#title').fill('Live privacy masking failure');
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=[data-action="capture"]')).toBeVisible({ timeout: 5_000 });
    await host.locator('css=[data-action="capture"]').click();

    await expect(host.locator('css=.bd-title')).toHaveText('Privacy masking failed', {
      timeout: 10_000,
    });
    await expect(host.locator('css=.bd-error-message__text')).toContainText(
      'Automatic redaction of private fields could not be applied'
    );
    await expect(host.locator('css=button').filter({ hasText: 'Try Again' })).toHaveCount(0);

    await host.locator('css=button').filter({ hasText: 'Continue without screenshot' }).click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10_000 });

    expect(payloads).toHaveLength(1);
    expect(payloads[0].screenshot).toBeNull();
  });
});

test.describe('Feedback Submission (Live)', () => {
  test('feedback form submits through a mocked transport and shows success', async ({ page }) => {
    const payloads: Array<Record<string, unknown>> = [];
    await page.route('**/feedback', async route => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          issueNumber: 1,
          issueUrl: 'https://github.com/mean-weasel/bugdrop-widget-test/issues/1',
          isPublic: false,
        }),
      });
    });

    // Mock the installation check to return installed: true
    await page.route('**/api/check/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    // Click "Get Started" on welcome screen
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
    await getStartedBtn.click();

    // Fill in feedback form
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await titleInput.fill('Live E2E test submission');

    // Submit form
    const submitBtn = page.locator('#bugdrop-host').locator('css=#submit-btn');
    await submitBtn.click();

    // Skip screenshot capture
    const skipBtn = page.locator('#bugdrop-host').locator('css=[data-action="skip"]');
    await expect(skipBtn).toBeVisible({ timeout: 5_000 });
    await skipBtn.click();

    // The ordinary live suite verifies UI/transport integration without mutating GitHub.
    const successScreen = page.locator('#bugdrop-host').locator('css=.bd-success-content');
    await expect(successScreen).toBeVisible({ timeout: 10_000 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].title).toBe('Live E2E test submission');
    expect(payloads[0].screenshot).toBeNull();
  });
});
