import { expect, type Page } from '@playwright/test';
import {
  assertExactPreviewWidgetResponse,
  test,
  waitForPreviewWidgetResponse,
} from './live-preview-widget';

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
      await route.continue({
        headers: {
          ...route.request().headers(),
          'x-vercel-protection-bypass': bypassSecret,
        },
      });
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

async function openForm(page: Page) {
  const host = page.locator('#bugdrop-host');
  const button = host.locator('css=.bd-trigger');
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();

  const getStartedBtn = host.locator('css=[data-action="continue"]');
  await expect(getStartedBtn).toBeVisible({ timeout: 5_000 });
  await getStartedBtn.click();

  await expect(host.locator('css=#title')).toBeVisible({ timeout: 5_000 });
  return host;
}

async function padDom(page: Page, count: number) {
  await page.evaluate(nodeCount => {
    const root = document.createElement('div');
    root.id = 'cross-browser-complexity-padding';

    for (let i = 0; i < nodeCount; i++) {
      const node = document.createElement('span');
      node.textContent = `Complex item ${i}`;
      root.appendChild(node);
    }

    document.body.appendChild(root);
  }, count);
}

async function padDomToNodeCount(page: Page, targetNodeCount: number) {
  const currentNodeCount = await page.evaluate(() => document.body.querySelectorAll('*').length);
  await padDom(page, Math.max(0, targetNodeCount - currentNodeCount));
}

test.describe('Cross-Browser Live Preview Smoke', () => {
  test('loads the expected preview widget asset', async ({ page }) => {
    const responsePromise = expectedWidgetOrigin
      ? waitForPreviewWidgetResponse(page, expectedWidgetOrigin)
      : undefined;
    await page.goto(venuePath);

    const host = page.locator('#bugdrop-host');
    await expect(host).toBeAttached({ timeout: 10_000 });
    await expect(host.locator('css=.bd-trigger')).toBeVisible({ timeout: 10_000 });

    const widgetSrc = await page.evaluate(() => {
      return (
        Array.from(document.scripts)
          .map(script => script.src)
          .find(src => src.includes('/widget.js')) || ''
      );
    });

    expect(widgetSrc).toBeTruthy();

    if (expectedWidgetOrigin) {
      expect(widgetSrc).toContain(`${expectedWidgetOrigin}/widget.js`);
    }

    if (responsePromise && expectedWidgetSha256) {
      await assertExactPreviewWidgetResponse(await responsePromise, expectedWidgetSha256);
    }
  });

  test('submits feedback without a screenshot', async ({ page }) => {
    await mockInstalledRepo(page);

    const payloads: Array<Record<string, unknown>> = [];
    await page.route('**/feedback', async route => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });

    await page.goto(venuePath);
    const host = await openForm(page);

    await host.locator('css=#title').fill('Cross-browser live smoke');
    await host.locator('css=#submit-btn').click();

    const skipBtn = host.locator('css=[data-action="skip"]');
    if (await skipBtn.isVisible().catch(() => false)) {
      await skipBtn.click();
    }

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10_000 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].screenshot).toBeNull();
  });

  test('submits a compact suggestion from the exact preview widget without a real Issue', async ({
    page,
  }) => {
    const responsePromise = expectedWidgetOrigin
      ? waitForPreviewWidgetResponse(page, expectedWidgetOrigin)
      : undefined;
    const payloads: Array<Record<string, unknown>> = [];
    await page.route('**/feedback', route => {
      if (route.request().method() !== 'POST') return route.continue();
      payloads.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          issueNumber: 2,
          issueUrl: 'https://github.com/bugdrophq/bugdrop-widget-test/issues/2',
          isPublic: false,
        }),
      });
    });
    await page.goto(venuePath);
    await expect
      .poll(() => page.evaluate(() => typeof window.BugDrop?.registerVariant))
      .toBe('function');
    if (responsePromise && expectedWidgetSha256) {
      await assertExactPreviewWidgetResponse(await responsePromise, expectedWidgetSha256);
    }
    await page.evaluate(() => {
      window
        .BugDrop!.registerVariant({
          id: 'cross-browser-live-compact-suggestion',
          presentation: { kind: 'modal', size: 'default' },
          content: { title: 'Share an idea', submitLabel: 'Submit idea' },
          fields: [
            { id: 'summary', type: 'shortText', label: 'Idea', required: true, maxLength: 120 },
            { id: 'detail', type: 'longText', label: 'How would this help?', maxLength: 2_000 },
          ],
          issue: {
            classification: 'feature',
            title: '[Idea] {{summary}}',
            sections: [
              { heading: 'Idea', field: 'summary' },
              { heading: 'Why it would help', field: 'detail', omitWhenEmpty: true },
            ],
          },
        })
        .open();
    });

    const variantHost = page.locator('body > [data-bugdrop-owned]');
    await variantHost.getByRole('textbox', { name: 'Idea' }).fill('Cross-browser preview idea');
    expect(payloads).toHaveLength(0);
    await variantHost.getByRole('button', { name: 'Submit idea' }).click();
    await expect(
      variantHost.getByRole('heading', { name: 'Thanks for your feedback!' })
    ).toBeVisible();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      kind: 'bugdrop.variant-submission',
      schemaVersion: 1,
      variantId: 'cross-browser-live-compact-suggestion',
      issue: {
        title: '[Idea] Cross-browser preview idea',
        classification: 'feature',
        sections: [{ heading: 'Idea', value: 'Cross-browser preview idea', format: 'text' }],
      },
    });
  });

  test('handles complex-page screenshot options without starting expensive capture', async ({
    browserName,
    page,
  }) => {
    await mockInstalledRepo(page);
    await page.goto(venuePath);
    await padDomToNodeCount(page, 4000);

    const host = await openForm(page);
    await host.locator('css=#title').fill('Cross-browser complex screenshot smoke');
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=[data-action="element"]')).toBeVisible({ timeout: 5_000 });

    if (browserName === 'webkit') {
      await expect(host.locator('css=[data-action="capture"]')).not.toBeAttached();
      await expect(host.locator('css=[data-action="area"]')).not.toBeAttached();
      await expect(host.locator('css=p >> text=too complex')).toBeVisible();
      return;
    }

    await expect(host.locator('css=[data-action="capture"]')).toBeVisible();
    await expect(host.locator('css=[data-action="area"]')).toBeVisible();
  });
});
