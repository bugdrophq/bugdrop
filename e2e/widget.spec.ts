import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_ACCENT_COLOR } from '../src/defaults';

type CaptureOptions = Record<string, unknown> & {
  pixelRatio?: number;
  cacheBust?: boolean;
  imagePlaceholder?: string;
  width?: number;
  height?: number;
};

declare global {
  interface Window {
    __hostKeystrokeCount?: number;
    __captureOpts?: CaptureOptions;
    __captureTargetInfo?: {
      tagName: string;
      id: string;
      className: string;
      width: number;
      height: number;
    };
    __ownedCaptureFilter?: boolean[];
  }
}

/**
 * E2E tests for BugDrop
 * Tests run against wrangler dev server at http://localhost:8787
 */

async function clearTriggerPositionStorage(page: Page) {
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter(key => key.startsWith('bugdrop_trigger_position_'))
      .forEach(key => localStorage.removeItem(key));
  });
}

async function dragTriggerHandle(page: Page, deltaY: number) {
  const handle = page.locator('#bugdrop-host').locator('css=.bd-trigger-drag-handle');
  await expect(handle).toBeVisible();

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

async function getWidgetRepo(page: Page) {
  return page.locator('script[src="/widget.js"]').evaluate(script => {
    return (script as HTMLScriptElement).dataset.repo;
  });
}

async function dragModalHeader(page: Page, deltaX: number, deltaY: number) {
  const header = page.locator('#bugdrop-host').locator('css=.bd-header');
  await expect(header).toBeVisible();

  const headerBox = await header.boundingBox();
  expect(headerBox).not.toBeNull();

  await page.mouse.move(headerBox!.x + headerBox!.width / 2, headerBox!.y + headerBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    headerBox!.x + headerBox!.width / 2 + deltaX,
    headerBox!.y + headerBox!.height / 2 + deltaY,
    { steps: 8 }
  );
  await page.mouse.up();
}

test.describe('Widget Loading', () => {
  test('page loads without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('BugDrop')) {
        errors.push(msg.text());
      }
    });

    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Filter out expected widget errors (missing repo in some test scenarios)
    const unexpectedErrors = errors.filter(e => !e.includes('Missing data-repo'));
    expect(unexpectedErrors).toHaveLength(0);
  });

  test('widget host element exists', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Widget creates a host element
    const host = page.locator('#bugdrop-host');
    await expect(host).toBeAttached();
  });

  test('feedback button is visible in shadow DOM', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Access button inside shadow DOM
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible();
  });

  test('feedback button is an edge label with a drag handle', async ({ page }) => {
    await page.goto('/test/');
    const host = page.locator('#bugdrop-host');
    const trigger = host.locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.evaluate(async el => {
      await Promise.all(el.getAnimations().map(animation => animation.finished));
    });

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(Math.round(triggerBox!.x + triggerBox!.width)).toBe(viewport!.width);

    await expect(trigger).toHaveCSS('border-top-right-radius', '0px');
    await expect(trigger).toHaveCSS('border-bottom-right-radius', '0px');
    await expect(host.locator('css=.bd-trigger-drag-handle')).toBeVisible();
    await expect(host.locator('css=.bd-trigger-drag-handle')).toHaveCSS('cursor', 'grab');
  });

  test('dragging the feedback button persists after reload', async ({ page }) => {
    await page.goto('/test/');
    await clearTriggerPositionStorage(page);
    await page.reload();

    const host = page.locator('#bugdrop-host');
    const trigger = host.locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    await dragTriggerHandle(page, -160);

    const draggedTop = await trigger.evaluate(el => el.getBoundingClientRect().top);
    const repo = await getWidgetRepo(page);
    const storedPosition = await page.evaluate(
      key => localStorage.getItem(key),
      `bugdrop_trigger_position_${repo}_bottom-right`
    );
    expect(storedPosition).not.toBeNull();

    await expect(host.locator('css=.bd-modal')).not.toBeVisible();
    await page.reload();
    await expect(trigger).toBeVisible({ timeout: 5000 });

    const restoredTop = await trigger.evaluate(el => el.getBoundingClientRect().top);
    expect(Math.abs(restoredTop - draggedTop)).toBeLessThanOrEqual(2);
  });

  test('feedback button position reclamps when the viewport is resized', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/test/');
    await clearTriggerPositionStorage(page);
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    await dragTriggerHandle(page, 500);
    await page.setViewportSize({ width: 900, height: 360 });

    await expect
      .poll(async () => {
        return trigger.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return window.innerHeight - rect.bottom;
        });
      })
      .toBeGreaterThanOrEqual(7);
  });

  test('viewport resize preserves an active feedback button drag', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/test/');
    await clearTriggerPositionStorage(page);
    await page.reload();

    const host = page.locator('#bugdrop-host');
    const trigger = host.locator('css=.bd-trigger');
    const handle = host.locator('css=.bd-trigger-drag-handle');
    await expect(handle).toBeVisible({ timeout: 5000 });
    await trigger.evaluate(async el => {
      await Promise.all(el.getAnimations().map(animation => animation.finished));
    });

    await dragTriggerHandle(page, -160);
    const repo = await getWidgetRepo(page);
    const storageKey = `bugdrop_trigger_position_${repo}_bottom-right`;
    const savedTop = Number(await page.evaluate(key => localStorage.getItem(key), storageKey));

    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const pointerX = handleBox!.x + handleBox!.width / 2;
    const pointerY = handleBox!.y + handleBox!.height / 2;
    await page.mouse.move(pointerX, pointerY);
    await page.mouse.down();
    await page.mouse.move(pointerX, pointerY + 80, { steps: 8 });

    const activeDragTop = await trigger.evaluate(el => el.getBoundingClientRect().top);
    expect(Math.abs(activeDragTop - savedTop)).toBeGreaterThan(40);

    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect
      .poll(() => trigger.evaluate(el => el.getBoundingClientRect().top))
      .toBeCloseTo(activeDragTop, 0);

    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(key => Number(localStorage.getItem(key)), storageKey))
      .toBe(Math.round(activeDragTop));
  });

  test('hidden feedback button keeps saved position across viewport resize', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto('/test/');
    await clearTriggerPositionStorage(page);
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    await dragTriggerHandle(page, -140);

    await page.evaluate(() => {
      (window as Window & { BugDrop?: { hide: () => void } }).BugDrop?.hide();
    });
    await page.setViewportSize({ width: 900, height: 500 });
    await page.evaluate(() => {
      (window as Window & { BugDrop?: { show: () => void } }).BugDrop?.show();
    });
    await page.mouse.move(10, 10);

    await expect
      .poll(async () => {
        return trigger.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return window.innerHeight - rect.bottom;
        });
      })
      .toBeGreaterThanOrEqual(0);

    const shownTop = await trigger.evaluate(el => el.getBoundingClientRect().top);
    expect(shownTop).toBeGreaterThan(100);
  });

  test('hovered feedback button does not drift saved position during resize', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/test/');
    await clearTriggerPositionStorage(page);
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    await dragTriggerHandle(page, -160);
    const repo = await getWidgetRepo(page);
    const storageKey = `bugdrop_trigger_position_${repo}_bottom-right`;
    const savedTop = await page.evaluate(key => localStorage.getItem(key), storageKey);
    expect(savedTop).not.toBeNull();

    await trigger.hover();
    await page.setViewportSize({ width: 900, height: 360 });

    await expect
      .poll(async () => {
        return trigger.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return rect.top >= 8 && window.innerHeight - rect.bottom >= 8;
        });
      })
      .toBe(true);

    const clampedBox = await trigger.boundingBox();
    expect(clampedBox).not.toBeNull();
    expect(clampedBox!.y).toBeGreaterThanOrEqual(8);
    expect(clampedBox!.y + clampedBox!.height).toBeLessThanOrEqual(352);
    await expect
      .poll(() => page.evaluate(key => localStorage.getItem(key), storageKey))
      .toBe(savedTop);

    await page.setViewportSize({ width: 900, height: 900 });
    await page.mouse.move(10, 10);

    await expect
      .poll(() => page.evaluate(key => localStorage.getItem(key), storageKey))
      .toBe(savedTop);

    await expect
      .poll(() => trigger.evaluate(el => el.getBoundingClientRect().top))
      .toBeCloseTo(Number(savedTop), 0);
  });

  test('missing local test config returns a javascript file', async ({ page }) => {
    const response = await page.request.get('/test/local-config.js');

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('text/javascript; charset=utf-8');
  });

  test('test pages use upstream repo when no local override is present', async ({ page }) => {
    await page.route('**/test/local-config.js', route => {
      return route.fulfill({ status: 404 });
    });

    await page.goto('/test/');

    const widgetScript = page.locator('script[src="/widget.js"]');
    await expect(widgetScript).toBeAttached();

    const repo = await widgetScript.evaluate(script => {
      return (script as HTMLScriptElement).dataset.repo;
    });

    expect(repo).toBe('mean-weasel/bugdrop-widget-test');
  });

  test('test pages use local repo override when configured', async ({ page }) => {
    await page.route('**/test/local-config.js', route => {
      return route.fulfill({
        contentType: 'application/javascript',
        body: `
          window.BugDropTestConfig = {
            ...(window.BugDropTestConfig || {}),
            repo: 'local-owner/local-repo',
          };
        `,
      });
    });

    await page.goto('/test/');

    const widgetScript = page.locator('script[src="/widget.js"]');
    await expect(widgetScript).toBeAttached();

    const repo = await widgetScript.evaluate(script => {
      return (script as HTMLScriptElement).dataset.repo;
    });

    expect(repo).toBe('local-owner/local-repo');
  });

  test('non-index test pages use local repo override when configured', async ({ page }) => {
    await page.route('**/test/local-config.js', route => {
      return route.fulfill({
        contentType: 'application/javascript',
        body: `
          window.BugDropTestConfig = {
            ...(window.BugDropTestConfig || {}),
            repo: 'local-owner/local-repo',
          };
        `,
      });
    });

    await page.goto('/test/color-default.html');

    const widgetScript = page.locator('script[src="/widget.js"]');
    await expect(widgetScript).toBeAttached();

    const repo = await widgetScript.evaluate(script => {
      return (script as HTMLScriptElement).dataset.repo;
    });

    expect(repo).toBe('local-owner/local-repo');
  });

  test('widget test fixtures use shared local config loader', async () => {
    const fixtureDir = join(process.cwd(), 'public', 'test');
    const fixtureNames = (await readdir(fixtureDir)).filter(name => name.endsWith('.html'));
    const nonWidgetFixtures = new Set(['pull-tab-mock.html', 'submissions.html']);

    for (const fixtureName of fixtureNames) {
      const source = await readFile(join(fixtureDir, fixtureName), 'utf8');
      const directWidgetScript = /<script\b(?=[^>]*\bsrc=["']\/widget\.js["'])/i.test(source);

      expect(
        directWidgetScript,
        `${fixtureName} should load the widget through load-widget.js`
      ).toBe(false);
      expect(source, `${fixtureName} should not hard-code the upstream test repo`).not.toContain(
        'data-repo="mean-weasel/bugdrop-widget-test"'
      );

      if (!nonWidgetFixtures.has(basename(fixtureName))) {
        expect(source, `${fixtureName} should include the shared test loader`).toContain(
          'src="/test/load-widget.js"'
        );
        expect(source, `${fixtureName} should call the shared test loader`).toContain(
          'loadBugDropTestWidget'
        );
      }
    }
  });
});

test.describe('Widget Interaction', () => {
  async function trackFeedbackPayloads(page: Page) {
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

  test('clicking feedback button triggers modal', async ({ page }) => {
    await page.goto('/test/');

    // Wait for widget to be ready
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });

    // Click the trigger button
    await button.click();

    // Modal should appear (or installation prompt if not installed)
    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });
  });

  test('rapid feedback button clicks during startup open one modal', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await page.waitForTimeout(500);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');
    await page.evaluate(() =>
      localStorage.removeItem('bugdrop_welcomed_mean-weasel/bugdrop-widget-test')
    );

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });

    await button.evaluate(trigger => {
      if (!(trigger instanceof HTMLElement)) {
        throw new Error('BugDrop trigger not found');
      }
      trigger.click();
      trigger.click();
      trigger.click();
    });

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('#bugdrop-host').locator('css=.bd-title')).toHaveText(
      'Share Your Feedback'
    );
  });

  test('console logs checkbox is unchecked by default', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    const host = page.locator('#bugdrop-host');
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();

    const consoleLogsCheckbox = host.locator('css=#send-console-logs');
    await expect(consoleLogsCheckbox).toBeVisible({ timeout: 5000 });
    await expect(consoleLogsCheckbox).not.toBeChecked();
  });

  test('console logs checkbox can default to checked from script settings', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/?sendConsoleLogs=true');

    const host = page.locator('#bugdrop-host');
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();

    await expect(host.locator('css=#send-console-logs')).toBeChecked({ timeout: 5000 });
  });

  test('checked console logs option submits captured browser logs', async ({ page }) => {
    const payloads = await trackFeedbackPayloads(page);
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');
    const host = page.locator('#bugdrop-host');
    await host.locator('css=.bd-trigger').waitFor({ state: 'visible', timeout: 5000 });

    await page.evaluate(() => {
      console.log('customer dashboard failed to save');
      console.warn('retry count', {
        token: 'abc123456789abcdefghijklmnopqrstuvwxyz',
        password: 'hunter2',
        cookie: 'sid=short',
      });
    });

    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await host.locator('css=#title').fill('Console log test');
    await host.locator('css=#include-screenshot').uncheck();
    await host.locator('css=#send-console-logs').check();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    expect(payloads).toHaveLength(1);
    const logs = payloads[0].consoleLogs;
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'log',
          message: expect.stringContaining('customer dashboard failed to save'),
        }),
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('[redacted]'),
        }),
      ])
    );
    expect(JSON.stringify(logs)).not.toContain('abc123456789abcdefghijklmnopqrstuvwxyz');
    expect(JSON.stringify(logs)).not.toContain('hunter2');
    expect(JSON.stringify(logs)).not.toContain('sid=short');
  });

  test('uploaded files can be selected, removed, and submitted', async ({ page }) => {
    const payloads = await trackFeedbackPayloads(page);
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');
    const host = page.locator('#bugdrop-host');
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();

    const uploadInput = host.locator('css=#attachment-upload');
    await uploadInput.setInputFiles([
      {
        name: 'first.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        ),
      },
      {
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\n'),
      },
    ]);

    await expect(host.locator('css=.bd-upload-item')).toHaveCount(2);
    await expect(host.locator('css=.bd-upload-item').first()).toContainText('first.png');
    await host.locator('css=.bd-upload-remove').first().click();
    await expect(host.locator('css=.bd-upload-item')).toHaveCount(1);
    await expect(host.locator('css=.bd-upload-item').first()).toContainText('notes.pdf');

    await host.locator('css=#title').fill('Uploaded evidence');
    await host.locator('css=#include-screenshot').uncheck();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].screenshot).toBeNull();
    expect(payloads[0].attachments).toEqual([
      expect.objectContaining({
        name: 'notes.pdf',
        type: 'application/pdf',
        dataUrl: expect.stringMatching(/^data:application\/pdf;base64,/),
      }),
    ]);
  });

  test('unsupported uploaded files show a clear message', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    const host = page.locator('#bugdrop-host');
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await host.locator('css=#attachment-upload').setInputFiles({
      name: 'archive.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('zip'),
    });

    await expect(host.locator('css=#attachment-error')).toContainText(
      'That file type is not supported'
    );
    await expect(host.locator('css=.bd-upload-item')).toHaveCount(0);
  });

  test('feedback modal can be moved by dragging the header on desktop', async ({ page }) => {
    await page.goto('/test/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    const before = await modal.boundingBox();
    expect(before).not.toBeNull();

    await dragModalHeader(page, -90, 70);

    const after = await modal.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.x).toBeLessThan(before!.x - 50);
    expect(after!.y).toBeGreaterThan(before!.y + 40);
  });

  test('feedback modal shows a centered drag indicator in the header', async ({ page }) => {
    await page.goto('/test/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    const indicator = page.locator('#bugdrop-host').locator('css=.bd-modal-drag-indicator');
    await expect(modal).toBeVisible({ timeout: 5000 });
    await expect(indicator).toBeVisible();

    const modalBox = await modal.boundingBox();
    const indicatorBox = await indicator.boundingBox();
    expect(modalBox).not.toBeNull();
    expect(indicatorBox).not.toBeNull();

    const modalCenter = modalBox!.x + modalBox!.width / 2;
    const indicatorCenter = indicatorBox!.x + indicatorBox!.width / 2;
    expect(Math.abs(indicatorCenter - modalCenter)).toBeLessThanOrEqual(4);
    expect(indicatorBox!.y).toBeLessThan(modalBox!.y + 16);
  });

  test('dragged feedback modal releases fixed sizing on mobile resize', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/test/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    await dragModalHeader(page, -90, 70);
    await page.setViewportSize({ width: 390, height: 720 });

    const afterResize = await modal.boundingBox();
    expect(afterResize).not.toBeNull();
    expect(afterResize!.x).toBeGreaterThanOrEqual(0);
    expect(afterResize!.width).toBeLessThanOrEqual(390);
  });
  test('dragged feedback modal reflows fixed sizing on narrow desktop resize', async ({ page }) => {
    await page.route('**/api/check**', route => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/test/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    await dragModalHeader(page, -90, 70);
    await page.setViewportSize({ width: 660, height: 720 });

    await expect
      .poll(async () => {
        const box = await modal.boundingBox();
        return box ? box.x + box.width : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(660);

    const afterResize = await modal.boundingBox();
    expect(afterResize).not.toBeNull();
    expect(afterResize!.width).toBeLessThanOrEqual(594);
  });

  test('element picker handles SVG elements without errors', async ({ page }) => {
    // Track console errors - specifically looking for className.split errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    page.on('pageerror', err => {
      errors.push(err.message);
    });

    // Mock the installation check to return installed: true
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    // Wait for widget to be ready
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });

    // Click the trigger button to open modal
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // New flow: Click "Get Started" on welcome screen
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    // Fill in the feedback form and check "Include screenshot"
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill('Test feedback for SVG');

    const screenshotCheckbox = page.locator('#bugdrop-host').locator('css=#include-screenshot');
    await screenshotCheckbox.check();

    // Click Continue to proceed to screenshot options
    const continueBtn = page.locator('#bugdrop-host').locator('css=#submit-btn');
    await continueBtn.click();

    // Click "Select Element" option
    const selectElementBtn = page.locator('#bugdrop-host').locator('css=[data-action="element"]');
    await expect(selectElementBtn).toBeVisible({ timeout: 5000 });
    await selectElementBtn.click();

    // Wait for element picker mode to be active
    await page.waitForTimeout(300);

    // Click on the SVG element - this previously caused className.split error
    const svgElement = page.locator('#test-svg');
    await expect(svgElement).toBeVisible();
    await svgElement.scrollIntoViewIfNeeded();
    const svgBox = await svgElement.boundingBox();
    expect(svgBox).not.toBeNull();
    await page.mouse.click(svgBox!.x + svgBox!.width / 2, svgBox!.y + svgBox!.height / 2);

    // Check for the className.split error that was previously occurring
    const classNameErrors = errors.filter(
      e => e.includes('className.split') || e.includes('split is not a function')
    );

    expect(classNameErrors).toHaveLength(0);

    // Annotation canvas should appear (indicating flow continued successfully to annotation step)
    const annotationCanvas = page.locator('#bugdrop-host').locator('css=#annotation-canvas');
    await expect(annotationCanvas).toBeVisible({ timeout: 5000 });
  });

  test('element picker handles nested SVG child elements without errors', async ({ page }) => {
    // Track console errors - the fix must handle nested SVG elements too
    // since getElementSelector walks up the DOM tree
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    page.on('pageerror', err => {
      errors.push(err.message);
    });

    // Mock the installation check to return installed: true
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    // Wait for widget to be ready
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });

    // Click the trigger button to open modal
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // New flow: Click "Get Started" on welcome screen
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    // Fill in the feedback form and check "Include screenshot"
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill('Test feedback for nested SVG');

    const screenshotCheckbox = page.locator('#bugdrop-host').locator('css=#include-screenshot');
    await screenshotCheckbox.check();

    // Click Continue to proceed to screenshot options
    const continueBtn = page.locator('#bugdrop-host').locator('css=#submit-btn');
    await continueBtn.click();

    // Click "Select Element" option
    const selectElementBtn = page.locator('#bugdrop-host').locator('css=[data-action="element"]');
    await expect(selectElementBtn).toBeVisible({ timeout: 5000 });
    await selectElementBtn.click();

    // Wait for element picker mode to be active
    await page.waitForTimeout(300);

    // Click on nested SVG child element (text inside SVG)
    // This tests that getElementSelector handles SVG elements when walking up the tree
    const svgText = page.locator('#test-svg text');
    await expect(svgText).toBeVisible();
    await svgText.scrollIntoViewIfNeeded();
    const svgTextBox = await svgText.boundingBox();
    expect(svgTextBox).not.toBeNull();
    await page.mouse.click(
      svgTextBox!.x + svgTextBox!.width / 2,
      svgTextBox!.y + svgTextBox!.height / 2
    );

    // Check for the className.split error
    const classNameErrors = errors.filter(
      e => e.includes('className.split') || e.includes('split is not a function')
    );

    expect(classNameErrors).toHaveLength(0);

    // Annotation canvas should appear
    const annotationCanvas = page.locator('#bugdrop-host').locator('css=#annotation-canvas');
    await expect(annotationCanvas).toBeVisible({ timeout: 5000 });
  });

  test('welcome screen only shows once per repo (default behavior)', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    // Clear welcome-seen state for this repo
    await page.evaluate(() =>
      localStorage.removeItem('bugdrop_welcomed_neonwatty/feedback-widget-test')
    );
    await page.reload();

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });

    // First open: welcome should appear
    await button.click();
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    // Form should appear
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // Close the modal
    const cancelBtn = page.locator('#bugdrop-host').locator('css=[data-action="cancel"]');
    await cancelBtn.click();
    const overlay = page.locator('#bugdrop-host').locator('css=.bd-overlay');
    await expect(overlay).not.toBeVisible({ timeout: 5000 });

    // Second open: welcome should be skipped, form appears directly
    await button.click();
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // Verify "Get Started" button is NOT present (welcome was skipped)
    await expect(getStartedBtn).not.toBeVisible();
  });

  test('data-welcome="false" skips welcome entirely', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/welcome-disabled.html');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });

    await button.click();

    // Form should appear directly, no welcome screen
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // Welcome "Get Started" button should NOT be present
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).not.toBeVisible();
  });

  test('data-welcome="always" shows welcome every time', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/welcome-always.html');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });

    // First open: welcome should appear
    await button.click();
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    // Form should appear
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // Close the modal and wait for it to disappear
    const cancelBtn = page.locator('#bugdrop-host').locator('css=[data-action="cancel"]');
    await cancelBtn.click();
    const overlay = page.locator('#bugdrop-host').locator('css=.bd-overlay');
    await expect(overlay).not.toBeVisible({ timeout: 5000 });

    // Second open: welcome should appear AGAIN (always mode)
    await button.click();
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
  });

  test('BugDrop.open() skips welcome screen', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    // Wait for BugDrop API to be available, then open programmatically
    await page.waitForFunction(() => typeof window.BugDrop !== 'undefined', {
      timeout: 5000,
    });
    await page.evaluate(() => {
      window.BugDrop?.open();
    });

    // Form should appear directly (no welcome screen)
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // Welcome "Get Started" button should NOT be present
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).not.toBeVisible();
  });

  test('screenshot checkbox is checked by default', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    // Click through welcome
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    // Verify screenshot checkbox is checked by default
    const screenshotCheckbox = page.locator('#bugdrop-host').locator('css=#include-screenshot');
    await expect(screenshotCheckbox).toBeChecked();
  });

  test('version number appears on welcome screen but not on form', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    const host = page.locator('#bugdrop-host');
    const button = host.locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    // Version should appear on the welcome screen
    const versionEl = host.locator('css=.bd-version');
    await expect(versionEl).toBeVisible({ timeout: 5000 });
    const versionText = await versionEl.textContent();
    expect(versionText).toMatch(/^BugDrop v/);

    // Advance to feedback form
    const getStartedBtn = host.locator('css=[data-action="continue"]');
    await getStartedBtn.click();

    // Version should NOT appear on the form screen
    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await expect(versionEl).not.toBeVisible();
  });

  test('select area button appears and launches area picker overlay', async ({ page }) => {
    const payloads = await trackFeedbackPayloads(page);
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    const host = page.locator('#bugdrop-host');
    const button = host.locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    // Click through welcome screen
    const getStartedBtn = host.locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    // Fill required title field and ensure screenshot checkbox is checked
    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill('Test bug report');

    const screenshotCheckbox = host.locator('css=#include-screenshot');
    await screenshotCheckbox.check();

    const submitBtn = host.locator('css=#submit-btn');
    await submitBtn.click();

    // Verify "Select Area" button appears in screenshot options
    const areaBtn = host.locator('css=[data-action="area"]');
    await expect(areaBtn).toBeVisible({ timeout: 5000 });

    // Click Select Area
    await areaBtn.click();

    // Area picker overlay should appear on the page (outside shadow DOM)
    const overlay = page.locator('#bugdrop-area-picker-overlay');
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // Tooltip should be visible
    const tooltip = page.locator('#bugdrop-area-picker-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText('Draw a selection around the area to capture (ESC to cancel)');
    await expect(page.locator('#bugdrop-area-picker-cancel')).not.toBeAttached();

    await page.keyboard.press('Escape');

    // Overlay should be removed
    await expect(overlay).not.toBeVisible({ timeout: 3000 });
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].screenshot).toBeNull();
  });

  test('area picker prompt clears mobile safe areas and uses an inline cancel link', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    try {
      const payloads = await trackFeedbackPayloads(page);
      await page.route('**/api/check**', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ installed: true }),
        });
      });

      await page.goto('/test/');
      await page.addStyleTag({
        content: `
          button {
            display: block;
            width: 100%;
          }
        `,
      });

      const host = page.locator('#bugdrop-host');
      await host.locator('css=.bd-trigger').click();
      await host.locator('css=[data-action="continue"]').click();
      await host.locator('css=#title').fill('Mobile safe area test');
      await host.locator('css=#include-screenshot').check();
      await host.locator('css=#submit-btn').click();
      await host.locator('css=[data-action="area"]').click();

      const tooltip = page.locator('#bugdrop-area-picker-tooltip');
      const cancelLink = page.locator('#bugdrop-area-picker-cancel');
      await expect(tooltip).toBeVisible({ timeout: 5000 });
      await expect(tooltip).not.toContainText('ESC');
      await expect(cancelLink).toHaveText('Cancel');

      await expect
        .poll(() => tooltip.evaluate(el => (el as HTMLElement).style.top))
        .toContain('safe-area-inset-top');
      await expect(cancelLink).toHaveCSS('display', 'inline-flex');
      const tooltipBox = await tooltip.boundingBox();
      const cancelBox = await cancelLink.boundingBox();
      expect(tooltipBox).not.toBeNull();
      expect(cancelBox).not.toBeNull();
      expect(cancelBox!.width).toBeGreaterThanOrEqual(44);
      expect(cancelBox!.height).toBeGreaterThanOrEqual(44);
      expect(cancelBox!.width).toBeLessThan(Math.min(140, tooltipBox!.width));

      await cancelLink.click();
      await expect(page.locator('#bugdrop-area-picker-overlay')).not.toBeVisible({
        timeout: 3000,
      });
      await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
      expect(payloads).toHaveLength(1);
      expect(payloads[0].screenshot).toBeNull();
    } finally {
      await context.close();
    }
  });

  test('area picker shows mobile cancel on hybrid touch devices', async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 900, height: 700 },
    });
    await context.addInitScript(() => {
      const nativeMatchMedia = window.matchMedia.bind(window);
      Object.defineProperty(navigator, 'maxTouchPoints', {
        configurable: true,
        value: 1,
      });
      window.matchMedia = query => {
        if (query.includes('any-pointer: coarse')) {
          return {
            matches: true,
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
          };
        }
        if (query.includes('hover: none') || query.includes('pointer: coarse')) {
          return {
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
          };
        }
        return nativeMatchMedia(query);
      };
    });
    const page = await context.newPage();

    try {
      const payloads = await trackFeedbackPayloads(page);
      await page.route('**/api/check**', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ installed: true }),
        });
      });

      await page.goto('/test/');

      const host = page.locator('#bugdrop-host');
      await host.locator('css=.bd-trigger').click();
      await host.locator('css=[data-action="continue"]').click();
      await host.locator('css=#title').fill('Hybrid touch area test');
      await host.locator('css=#include-screenshot').check();
      await host.locator('css=#submit-btn').click();
      await host.locator('css=[data-action="area"]').click();

      await expect(page.locator('#bugdrop-area-picker-tooltip')).not.toContainText('ESC');
      const cancelButton = page.locator('#bugdrop-area-picker-cancel');
      await expect(cancelButton).toHaveText('Cancel');

      await cancelButton.click();
      await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
      expect(payloads).toHaveLength(1);
      expect(payloads[0].screenshot).toBeNull();
    } finally {
      await context.close();
    }
  });

  test('area picker touch drags pass through non-link prompt text', async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    try {
      await page.route('**/api/check**', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ installed: true }),
        });
      });

      await page.goto('/test/');

      const host = page.locator('#bugdrop-host');
      await host.locator('css=.bd-trigger').click();
      await host.locator('css=[data-action="continue"]').click();
      await host.locator('css=#title').fill('Prompt pass-through test');
      await host.locator('css=#include-screenshot').check();
      await host.locator('css=#submit-btn').click();
      await host.locator('css=[data-action="area"]').click();

      const tooltip = page.locator('#bugdrop-area-picker-tooltip');
      await expect(tooltip).toBeVisible({ timeout: 5000 });

      const tooltipBox = await tooltip.boundingBox();
      expect(tooltipBox).not.toBeNull();
      const startX = Math.round(tooltipBox!.x + tooltipBox!.width / 2);
      const startY = Math.round(tooltipBox!.y + 8);

      await page.evaluate(
        ({ x, y }) => {
          const startTarget = document.elementFromPoint(x, y);
          if (!startTarget) throw new Error('no start target for prompt drag');

          startTarget.dispatchEvent(
            new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              pointerId: 2,
              pointerType: 'touch',
              isPrimary: true,
              buttons: 1,
            })
          );
          document.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y + 180,
              pointerId: 2,
              pointerType: 'touch',
              isPrimary: true,
              buttons: 1,
            })
          );
        },
        { x: startX, y: startY }
      );

      await expect(page.locator('#bugdrop-area-picker-selection')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('area picker accepts touch drag selection on mobile', async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    try {
      await page.route('**/api/check**', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ installed: true }),
        });
      });

      await page.goto('/test/');

      const host = page.locator('#bugdrop-host');
      await host.locator('css=.bd-trigger').click();
      await host.locator('css=[data-action="continue"]').click();
      await host.locator('css=#title').fill('Mobile area test');
      await host.locator('css=#include-screenshot').check();
      await host.locator('css=#submit-btn').click();
      await host.locator('css=[data-action="area"]').click();

      const overlay = page.locator('#bugdrop-area-picker-overlay');
      await expect(overlay).toBeVisible({ timeout: 5000 });

      const client = await context.newCDPSession(page);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: 40, y: 160, radiusX: 1, radiusY: 1, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: 280, y: 420, radiusX: 1, radiusY: 1, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await client.detach();

      await expect(overlay).not.toBeVisible({ timeout: 5000 });
      await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });
    } finally {
      await context.close();
    }
  });

  test('element picker prevents selected mobile tap from reaching the page', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    try {
      await page.route('**/api/check**', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ installed: true }),
        });
      });
      await page.addInitScript(`
        window.__bugdropMockToPng = function(el) {
          var rect = el.getBoundingClientRect();
          window.__captureTargetInfo = {
            tagName: el.tagName,
            id: el.id || '',
            className: typeof el.className === 'string' ? el.className : '',
            width: rect.width,
            height: rect.height
          };
          return Promise.resolve('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
        };
      `);

      await page.goto('/test/');
      await page.evaluate(() => {
        const target = document.createElement('button');
        target.id = 'mobile-select-action-target';
        target.textContent = 'Continue';
        target.style.cssText = `
          position: fixed;
          left: 40px;
          top: 180px;
          width: 220px;
          height: 64px;
          z-index: 1;
        `;
        target.addEventListener('pointerup', () => {
          document.body.dataset.mobileTapAction = 'fired';
        });
        target.addEventListener('click', () => {
          document.body.dataset.mobileClickAction = 'fired';
        });
        document.body.appendChild(target);
        document.body.dataset.mobileTapAction = 'idle';
        document.body.dataset.mobileClickAction = 'idle';
      });

      const host = page.locator('#bugdrop-host');
      await host.locator('css=.bd-trigger').click();
      await host.locator('css=[data-action="continue"]').click();
      await host.locator('css=#title').fill('Mobile element tap test');
      await host.locator('css=#include-screenshot').check();
      await host.locator('css=#submit-btn').click();
      await host.locator('css=[data-action="element"]').click();

      await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });
      await page.evaluate(() => {
        window.addEventListener(
          'pointerup',
          () => {
            document.body.dataset.mobileCapturePointerAction = 'fired';
          },
          true
        );
        document.body.dataset.mobileCapturePointerAction = 'idle';
      });

      const targetBox = await page.locator('#mobile-select-action-target').boundingBox();
      expect(targetBox).not.toBeNull();
      const tapX = Math.round(targetBox!.x + targetBox!.width / 2);
      const tapY = Math.round(targetBox!.y + targetBox!.height / 2);

      const client = await context.newCDPSession(page);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: tapX, y: tapY, radiusX: 1, radiusY: 1, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await client.detach();

      await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });
      await expect
        .poll(() => page.evaluate(() => document.body.dataset.mobileTapAction))
        .toBe('idle');
      await expect
        .poll(() => page.evaluate(() => document.body.dataset.mobileClickAction))
        .toBe('idle');
      await expect
        .poll(() => page.evaluate(() => document.body.dataset.mobileCapturePointerAction))
        .toBe('idle');

      const targetInfo = await page.evaluate(() => window.__captureTargetInfo);
      expect(targetInfo).toBeDefined();
      if (!targetInfo) throw new Error('Missing capture target info');
      expect(targetInfo.tagName).toBe('BUTTON');
      expect(targetInfo.id).toBe('mobile-select-action-target');
    } finally {
      await context.close();
    }
  });

  test('element picker exposes a mobile cancel affordance', async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const submissions: unknown[] = [];

    try {
      await page.route('**/api/check**', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ installed: true }),
        });
      });
      await page.route('**/feedback', async route => {
        submissions.push(route.request().postDataJSON());
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
        });
      });

      await page.goto('/test/');
      const host = page.locator('#bugdrop-host');
      await host.locator('css=.bd-trigger').click();
      await host.locator('css=[data-action="continue"]').click();
      await host.locator('css=#title').fill('Mobile element cancel test');
      await host.locator('css=#include-screenshot').check();
      await host.locator('css=#submit-btn').click();
      await host.locator('css=[data-action="element"]').click();

      const cancelButton = page.locator('#bugdrop-element-picker-cancel');
      await expect(cancelButton).toBeVisible({ timeout: 5000 });
      await cancelButton.click();

      await expect(page.locator('#bugdrop-element-picker-tooltip')).not.toBeVisible({
        timeout: 5000,
      });
      await expect(host.locator('css=.bd-trigger')).toBeVisible({ timeout: 5000 });
      expect(submissions).toHaveLength(1);
      const payload = submissions[0] as {
        screenshot: string | null;
        metadata: { elementSelector?: string | null; fullElementSelector?: string | null };
      };
      expect(payload.screenshot).toBeNull();
      expect(payload.metadata.elementSelector).toBeNull();
      expect(payload.metadata.fullElementSelector).toBeNull();
    } finally {
      await context.close();
    }
  });

  test('screenshot options prioritize capture actions before skip', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/test/');

    const host = page.locator('#bugdrop-host');
    const button = host.locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    const getStartedBtn = host.locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill('Test screenshot hierarchy');

    const screenshotCheckbox = host.locator('css=#include-screenshot');
    await screenshotCheckbox.check();

    const submitBtn = host.locator('css=#submit-btn');
    await submitBtn.click();

    const actions = host.locator('css=.bd-screenshot-actions [data-action]');
    await expect(actions).toHaveCount(4);

    const actionOrder = await actions.evaluateAll(buttons =>
      buttons.map(button => (button as HTMLElement).dataset.action)
    );
    expect(actionOrder).toEqual(['capture', 'area', 'element', 'skip']);

    await expect(host.locator('css=[data-action="capture"]')).toHaveClass(/bd-btn-primary/);
    await expect(host.locator('css=[data-action="skip"]')).toHaveClass(/bd-btn-quiet/);

    const verticalPositions = await actions.evaluateAll(buttons =>
      buttons.map(button => Math.round((button as HTMLElement).getBoundingClientRect().top))
    );
    expect(verticalPositions).toEqual([...verticalPositions].sort((a, b) => a - b));
  });

  test('retake button on annotation step returns to screenshot options', async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/');

    const host = page.locator('#bugdrop-host');
    const button = host.locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    // Click through welcome
    const getStartedBtn = host.locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    // Fill form and submit with screenshot
    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill('Test retake');

    const screenshotCheckbox = host.locator('css=#include-screenshot');
    await screenshotCheckbox.check();

    const submitBtn = host.locator('css=#submit-btn');
    await submitBtn.click();

    // Click "Full Page" to capture
    const fullPageBtn = host.locator('css=[data-action="capture"]');
    await expect(fullPageBtn).toBeVisible({ timeout: 5000 });
    await fullPageBtn.click();

    // Wait for annotation step to appear (screenshot capture can take several seconds)
    const retakeBtn = host.locator('css=[data-action="retake"]');
    await expect(retakeBtn).toBeVisible({ timeout: 15000 });

    // Click Retake
    await retakeBtn.click();

    // Should be back at screenshot options
    await expect(fullPageBtn).toBeVisible({ timeout: 5000 });

    // All 4 screenshot options should be available
    const skipBtn = host.locator('css=[data-action="skip"]');
    const elementBtn = host.locator('css=[data-action="element"]');
    const areaBtn = host.locator('css=[data-action="area"]');
    await expect(skipBtn).toBeVisible();
    await expect(elementBtn).toBeVisible();
    await expect(areaBtn).toBeVisible();
  });
});

test.describe('API Endpoints', () => {
  test('health endpoint returns ok', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data.status).toBe('ok');
    expect(data.environment).toBeDefined();
    expect(data.timestamp).toBeDefined();
  });

  test('health endpoint has CORS headers', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.headers()['access-control-allow-origin']).toBe('*');
  });

  test('feedback endpoint validates required fields', async ({ request }) => {
    // Missing repo
    const res1 = await request.post('/api/feedback', {
      data: { title: 'Test', description: 'Test' },
    });
    expect(res1.status()).toBe(400);

    // Missing title
    const res2 = await request.post('/api/feedback', {
      data: { repo: 'owner/repo', description: 'Test' },
    });
    expect(res2.status()).toBe(400);

    // Missing description (optional — should not return 400)
    const res3 = await request.post('/api/feedback', {
      data: { repo: 'owner/repo', title: 'Test' },
    });
    expect(res3.status()).not.toBe(400);
  });

  test('feedback endpoint rejects invalid repo format', async ({ request }) => {
    const response = await request.post('/api/feedback', {
      data: {
        repo: 'invalid-format',
        title: 'Test',
        description: 'Test',
        metadata: {
          url: 'http://test.com',
          userAgent: 'test',
          viewport: { width: 1920, height: 1080 },
          timestamp: new Date().toISOString(),
        },
      },
    });
    expect(response.status()).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Invalid repo format');
  });
});

test.describe('Dismissible Button', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage before each test
    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
  });

  test('close icon appears on hover when dismissible is enabled', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Close button should exist but be hidden initially
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toBeAttached();

    // Check that close button has opacity 0 initially (hidden)
    const initialOpacity = await closeBtn.evaluate(el => getComputedStyle(el).opacity);
    expect(parseFloat(initialOpacity)).toBeLessThan(0.5);

    // Hover over the trigger button
    await trigger.hover();

    // Wait for transition and check opacity is now 1 (visible)
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    const hoverOpacity = await closeBtn.evaluate(el => getComputedStyle(el).opacity);
    expect(parseFloat(hoverOpacity)).toBeGreaterThan(0.5);
  });

  test('clicking close icon hides the button', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Hover to reveal close button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });

    // Click the close button
    await closeBtn.click();

    // Trigger should no longer exist
    await expect(trigger).not.toBeAttached();
  });

  test('clicking close icon does not open feedback modal', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Hover to reveal close button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });

    // Click the close button
    await closeBtn.click();

    // Modal should not appear
    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).not.toBeVisible();
  });

  test('button stays hidden after page reload (localStorage persistence)', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Hover and click close button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();

    // Verify button is gone
    await expect(trigger).not.toBeAttached();

    // Reload the page
    await page.reload();
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });

    // Button should still be hidden
    const triggerAfterReload = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(triggerAfterReload).not.toBeAttached();
  });

  test('button appears normally when dismissible is not enabled', async ({ page }) => {
    // Use the regular test page (no dismissible attribute)
    await page.goto('/test/');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Close button should NOT exist
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).not.toBeAttached();
  });

  test('localStorage dismissed state is ignored when dismissible is false', async ({ page }) => {
    // Set localStorage as if button was dismissed
    await page.goto('/test/');
    await page.evaluate(() => localStorage.setItem('bugdrop_dismissed', 'true'));

    // Reload page (regular test page without dismissible)
    await page.reload();
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Button should still be visible because dismissible is not enabled
    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });
  });

  // === Edge Case Tests ===

  test('dismissible button works in light theme', async ({ page }) => {
    await page.goto('/test/dismissible-light.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Close button should exist
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toBeAttached();

    // Hover to reveal close button
    await trigger.hover();
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });

    // Verify close button is visible
    const hoverOpacity = await closeBtn.evaluate(el => getComputedStyle(el).opacity);
    expect(parseFloat(hoverOpacity)).toBeGreaterThan(0.5);

    // Click close and verify dismiss works
    await closeBtn.click();
    await expect(trigger).not.toBeAttached();

    // Verify persistence
    await page.reload();
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });
    await expect(page.locator('#bugdrop-host').locator('css=.bd-trigger')).not.toBeAttached();
  });

  test('dismissible button works with bottom-left position', async ({ page }) => {
    await page.goto('/test/dismissible-left.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await clearTriggerPositionStorage(page);
    await page.reload();

    const host = page.locator('#bugdrop-host');
    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Verify button is on the left side
    const buttonBox = await trigger.boundingBox();
    expect(buttonBox).not.toBeNull();
    if (buttonBox) {
      // Button should be closer to left edge than right edge
      const viewportWidth = await page.evaluate(() => window.innerWidth);
      expect(buttonBox.x).toBeLessThan(viewportWidth / 2);
    }

    await expect(trigger).toHaveCSS('border-top-left-radius', '0px');
    await expect(trigger).toHaveCSS('border-bottom-left-radius', '0px');

    const firstChildClass = await trigger.evaluate(el => el.firstElementChild?.className);
    expect(firstChildClass).toContain('bd-trigger-drag-handle');

    await dragTriggerHandle(page, -120);
    const repo = await getWidgetRepo(page);
    const leftPosition = await page.evaluate(
      key => localStorage.getItem(key),
      `bugdrop_trigger_position_${repo}_bottom-left`
    );
    const rightPosition = await page.evaluate(
      key => localStorage.getItem(key),
      `bugdrop_trigger_position_${repo}_bottom-right`
    );
    expect(leftPosition).not.toBeNull();
    expect(rightPosition).toBeNull();

    // Close button should exist and work
    const closeBtn = host.locator('css=.bd-trigger-close');
    await expect(closeBtn).toBeAttached();

    // Hover and dismiss
    await trigger.hover();
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();
    await expect(trigger).not.toBeAttached();
  });

  test('drag handle top area does not dismiss the feedback button', async ({ page }) => {
    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await clearTriggerPositionStorage(page);
    await page.reload();

    const host = page.locator('#bugdrop-host');
    const trigger = host.locator('css=.bd-trigger');
    const handle = host.locator('css=.bd-trigger-drag-handle');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();

    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 4);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y - 100, { steps: 8 });
    await page.mouse.up();

    await expect(trigger).toBeVisible();
    await expect(host.locator('css=.bd-pull-tab')).not.toBeAttached();
    expect(await page.evaluate(() => localStorage.getItem('bugdrop_dismissed'))).toBeNull();
  });

  test('close icon is always visible on touch devices', async ({ browser }) => {
    // Create a context with touch device emulation
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 }, // iPhone 14 Pro dimensions
    });
    const page = await context.newPage();

    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toBeAttached();

    // On touch devices, close button should be visible without hover
    // due to @media (hover: none) CSS rule
    const opacity = await closeBtn.evaluate(el => getComputedStyle(el).opacity);
    expect(parseFloat(opacity)).toBe(1);

    // Tap to dismiss should work
    await closeBtn.tap();
    await expect(trigger).not.toBeAttached();

    await context.close();
  });

  test('keyboard accessibility - dismiss with Enter key', async ({ page }) => {
    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Hover to reveal close button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });

    // Focus the close button and press Enter
    await closeBtn.focus();
    await page.keyboard.press('Enter');

    // Button should be dismissed
    await expect(trigger).not.toBeAttached();
  });

  test('keyboard accessibility - dismiss with Space key', async ({ page }) => {
    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Hover to reveal close button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });

    // Focus the close button and press Space
    await closeBtn.focus();
    await page.keyboard.press('Space');

    // Button should be dismissed
    await expect(trigger).not.toBeAttached();
  });

  test('close icon changes to red/error color on direct hover', async ({ page }) => {
    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');

    // Hover over trigger first to reveal close button
    await trigger.hover();
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });

    // Get initial background color
    const initialBg = await closeBtn.evaluate(el => getComputedStyle(el).backgroundColor);

    // Now hover directly on close button
    await closeBtn.hover();
    await page.waitForTimeout(100);

    // Get hovered background color
    const hoveredBg = await closeBtn.evaluate(el => getComputedStyle(el).backgroundColor);

    // Colors should be different (close button turns red on hover)
    expect(hoveredBg).not.toBe(initialBg);

    // Verify it's a reddish color (error color)
    // Parse RGB and check red channel is dominant
    const rgbMatch = hoveredBg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
      const [, r, g, b] = rgbMatch.map(Number);
      expect(r).toBeGreaterThan(200); // High red
      expect(r).toBeGreaterThan(g); // Red > Green
      expect(r).toBeGreaterThan(b); // Red > Blue
    }
  });

  test('localStorage key is set correctly on dismiss (timestamp format)', async ({ page }) => {
    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Verify localStorage is empty before dismiss
    const beforeDismiss = await page.evaluate(() => localStorage.getItem('bugdrop_dismissed'));
    expect(beforeDismiss).toBeNull();

    // Dismiss the button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();

    // Verify localStorage key is set to a timestamp (number)
    const afterDismiss = await page.evaluate(() => localStorage.getItem('bugdrop_dismissed'));
    expect(afterDismiss).not.toBeNull();
    const timestamp = parseInt(afterDismiss!, 10);
    expect(isNaN(timestamp)).toBe(false);
    // Timestamp should be recent (within last minute)
    expect(Date.now() - timestamp).toBeLessThan(60000);

    // Verify only our key was set (no other bugdrop keys)
    const allKeys = await page.evaluate(() =>
      Object.keys(localStorage).filter(k => k.includes('bugdrop'))
    );
    expect(allKeys).toEqual(['bugdrop_dismissed']);
  });

  test('legacy "true" localStorage value still works (permanent dismiss)', async ({ page }) => {
    await page.goto('/test/dismissible.html');
    // Set legacy 'true' value
    await page.evaluate(() => localStorage.setItem('bugdrop_dismissed', 'true'));
    await page.reload();
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });

    // Button should be hidden
    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).not.toBeAttached();
  });

  test('BugDrop.show() brings back dismissed button', async ({ page }) => {
    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Dismiss the button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();

    // Verify button is gone
    await expect(trigger).not.toBeAttached();

    // Verify localStorage is set
    const dismissed = await page.evaluate(() => localStorage.getItem('bugdrop_dismissed'));
    expect(dismissed).not.toBeNull();

    // Call BugDrop.show() to bring button back
    await page.evaluate(() => window.BugDrop?.show());
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Button should be visible again
    const triggerAfterShow = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(triggerAfterShow).toBeVisible();

    // localStorage should be cleared
    const dismissedAfterShow = await page.evaluate(() => localStorage.getItem('bugdrop_dismissed'));
    expect(dismissedAfterShow).toBeNull();
  });

  test('BugDrop.show() works even after page reload when dismissed', async ({ page }) => {
    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Dismiss the button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();
    await expect(trigger).not.toBeAttached();

    // Reload the page - button should still be hidden
    await page.reload();
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });
    const triggerAfterReload = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(triggerAfterReload).not.toBeAttached();

    // Call BugDrop.show() to bring button back
    await page.evaluate(() => window.BugDrop?.show());
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Button should be visible
    const triggerAfterShow = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(triggerAfterShow).toBeVisible();
  });

  test('clearing localStorage restores the button', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    // First dismiss the button
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();
    await expect(trigger).not.toBeAttached();

    // Now clear localStorage and reload
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Button should be visible again
    const triggerRestored = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(triggerRestored).toBeVisible({ timeout: 5000 });
  });

  test('widget handles localStorage errors gracefully', async ({ page }) => {
    // Track console errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    page.on('pageerror', err => {
      errors.push(err.message);
    });

    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));

    // Override localStorage to throw errors
    await page.evaluate(() => {
      const originalSetItem = localStorage.setItem.bind(localStorage);
      const _originalGetItem = localStorage.getItem.bind(localStorage);

      Object.defineProperty(window, 'localStorage', {
        value: {
          getItem: () => {
            throw new Error('localStorage blocked');
          },
          setItem: () => {
            throw new Error('localStorage blocked');
          },
          removeItem: originalSetItem,
          clear: () => {},
          key: () => null,
          length: 0,
        },
        writable: true,
      });
    });

    // Reload with broken localStorage
    await page.reload();
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Widget should still load (graceful degradation)
    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Dismiss should still work visually (even if not persisted)
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();

    // Button should be hidden
    await expect(trigger).not.toBeAttached();

    // No uncaught errors related to localStorage
    const localStorageErrors = errors.filter(e => e.includes('localStorage'));
    expect(localStorageErrors).toHaveLength(0);
  });

  test('rapid double-click on close button does not cause errors', async ({ page }) => {
    // Track console errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    page.on('pageerror', err => {
      errors.push(err.message);
    });

    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Hover to reveal close button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });

    // Click the close button
    await closeBtn.click();

    // Button should be removed (pull tab should appear instead)
    await expect(trigger).not.toBeAttached();

    // Pull tab should be visible
    const pullTab = page.locator('#bugdrop-host').locator('css=.bd-pull-tab');
    await expect(pullTab).toBeAttached();

    // No errors should occur
    expect(errors).toHaveLength(0);
  });
});

test.describe('Dismiss Duration', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage before each test
    await page.goto('/test/dismissible-duration.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
  });

  test('button reappears when dismiss duration has passed', async ({ page }) => {
    await page.goto('/test/dismissible-duration.html');

    // Set an old timestamp (8 days ago, duration is 7 days)
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await page.evaluate(
      ts => localStorage.setItem('bugdrop_dismissed', ts.toString()),
      eightDaysAgo
    );

    // Reload the page
    await page.reload();
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Button should be visible again (8 days > 7 day duration)
    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });
  });

  test('button stays hidden when dismiss duration has not passed', async ({ page }) => {
    await page.goto('/test/dismissible-duration.html');

    // Set a recent timestamp (3 days ago, duration is 7 days)
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    await page.evaluate(
      ts => localStorage.setItem('bugdrop_dismissed', ts.toString()),
      threeDaysAgo
    );

    // Reload the page
    await page.reload();
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });

    // Button should still be hidden (3 days < 7 day duration)
    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).not.toBeAttached();
  });

  test('button hidden immediately after dismissing', async ({ page }) => {
    await page.goto('/test/dismissible-duration.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
    await page.reload();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Dismiss the button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();

    // Button should be hidden
    await expect(trigger).not.toBeAttached();

    // Reload and verify still hidden
    await page.reload();
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });
    const triggerAfterReload = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(triggerAfterReload).not.toBeAttached();
  });

  test('dismiss duration is ignored when button is not dismissible', async ({ page }) => {
    // Use regular test page (no dismissible flag)
    await page.goto('/test/');

    // Set an old timestamp
    const oldTimestamp = Date.now() - 100 * 24 * 60 * 60 * 1000;
    await page.evaluate(
      ts => localStorage.setItem('bugdrop_dismissed', ts.toString()),
      oldTimestamp
    );
    await page.reload();
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Button should be visible because dismissible is not enabled
    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Keyboard Event Isolation', () => {
  test('typing in widget inputs does not leak keystrokes to host page', async ({ page }) => {
    // Mock the installation check so the feedback form loads
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/keyboard-conflict.html');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Track host-page keydown events that fire while BugDrop is open
    await page.evaluate(() => {
      window.__hostKeystrokeCount = 0;
      document.addEventListener('keydown', () => {
        if (document.getElementById('bugdrop-host')) {
          window.__hostKeystrokeCount = (window.__hostKeystrokeCount ?? 0) + 1;
        }
      });
    });

    // Open the widget
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Skip welcome screen if present
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    if (await getStartedBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await getStartedBtn.click();
    }

    // Type into the title INPUT using real keyboard events
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.click();
    await page.keyboard.type('Test keystroke isolation');

    // Type into the description TEXTAREA
    const descInput = page.locator('#bugdrop-host').locator('css=#description');
    await expect(descInput).toBeVisible({ timeout: 5000 });
    await descInput.click();
    await page.keyboard.type('Also testing textarea');

    // Verify text was actually entered (stopPropagation must not swallow input events)
    await expect(titleInput).toHaveValue('Test keystroke isolation');
    await expect(descInput).toHaveValue('Also testing textarea');

    // Host page should NOT have received any keystrokes
    const leakedCount = await page.evaluate(() => window.__hostKeystrokeCount ?? 0);
    expect(leakedCount).toBe(0);
  });
});

test.describe('Install URL from appName', () => {
  test('uses server-provided appName in install link', async ({ page }) => {
    // Mock /check to return installed: false with a custom appName
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: false, appName: 'my-custom-app' }),
      });
    });

    await page.goto('/test/keyboard-conflict.html');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Open the widget
    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // The install prompt should contain a link using the server-provided appName
    const installLink = page.locator('#bugdrop-host').locator('css=a.bd-btn-primary');
    await expect(installLink).toBeVisible({ timeout: 5000 });
    await expect(installLink).toHaveAttribute(
      'href',
      'https://github.com/apps/my-custom-app/installations/new'
    );
  });

  test('falls back to URL-derived appName when server omits it', async ({ page }) => {
    // Mock /check to return installed: false without appName
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: false }),
      });
    });

    await page.goto('/test/keyboard-conflict.html');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const button = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Should still show an install link using the fallback-derived name
    const installLink = page.locator('#bugdrop-host').locator('css=a.bd-btn-primary');
    await expect(installLink).toBeVisible({ timeout: 5000 });
    const href = await installLink.getAttribute('href');
    expect(href).toMatch(/^https:\/\/github\.com\/apps\/.+\/installations\/new$/);
    // Should NOT contain the custom app name (proving fallback was used)
    expect(href).not.toContain('my-custom-app');
  });
});

test.describe('Widget Build', () => {
  test('widget.js is accessible', async ({ request }) => {
    const response = await request.get('/widget.js');
    expect(response.ok()).toBeTruthy();

    const content = await response.text();
    expect(content).toContain('use strict');
  });

  test('widget.js is an IIFE bundle', async ({ request }) => {
    const response = await request.get('/widget.js');
    const content = await response.text();

    // IIFE pattern starts with (()=>{ or similar
    expect(content).toMatch(/^\s*["']use strict["'];?\s*\(\s*\(\s*\)\s*=>\s*\{/);
  });

  test('versioned widget files are accessible', async ({ request }) => {
    // Read versions.json to get the actual versioned filenames
    const versionsResp = await request.get('/versions.json');
    expect(versionsResp.ok()).toBeTruthy();

    const manifest = await versionsResp.json();
    const versionedFiles = Object.values(manifest.versions) as string[];

    for (const filename of versionedFiles) {
      const response = await request.get(`/${filename}`);
      expect(response.ok(), `${filename} should be accessible`).toBeTruthy();
    }
  });

  test('versioned widget files contain identical content to widget.js', async ({ request }) => {
    const baseResp = await request.get('/widget.js');
    const baseContent = await baseResp.text();

    const versionsResp = await request.get('/versions.json');
    const manifest = await versionsResp.json();
    const versionedFiles = Object.values(manifest.versions) as string[];

    for (const filename of versionedFiles) {
      const response = await request.get(`/${filename}`);
      const content = await response.text();
      expect(content, `${filename} should match widget.js`).toBe(baseContent);
    }
  });
});

test.describe('JavaScript API', () => {
  test('window.BugDrop exists after widget loads', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const hasBugDrop = await page.evaluate(() => {
      return typeof window.BugDrop === 'object' && window.BugDrop !== null;
    });
    expect(hasBugDrop).toBeTruthy();
  });

  test('BugDrop API has all expected methods', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const apiMethods = await page.evaluate(() => {
      if (!window.BugDrop) return [];
      return Object.keys(window.BugDrop);
    });

    expect(apiMethods).toContain('open');
    expect(apiMethods).toContain('close');
    expect(apiMethods).toContain('hide');
    expect(apiMethods).toContain('show');
    expect(apiMethods).toContain('isOpen');
    expect(apiMethods).toContain('isButtonVisible');
    expect(apiMethods).toContain('registerFlow');
    expect(apiMethods).toContain('registerVariant');
  });

  test('bugdrop:ready event fires after initialization', async ({ page }) => {
    // Use the api-only test page which sets up a listener for the event
    await page.goto('/test/api-only.html');

    // Wait for the status to update (indicating bugdrop:ready was received)
    await page.waitForFunction(
      () => {
        const status = document.getElementById('status');
        return status?.textContent?.includes('BugDrop ready');
      },
      { timeout: 5000 }
    );

    // Verify the event was received
    const statusText = await page.locator('#status').textContent();
    expect(statusText).toContain('BugDrop ready');
  });

  test('bugdrop:ready keeps its exact event semantics and exposes the API first', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const state = {
        documentCount: 0,
        events: [] as Array<Record<string, unknown>>,
      };
      (window as Window & { __bugdropReadyState?: typeof state }).__bugdropReadyState = state;
      document.addEventListener('bugdrop:ready', () => {
        state.documentCount += 1;
      });
      window.addEventListener('bugdrop:ready', event => {
        state.events.push({
          targetIsWindow: event.target === window,
          bubbles: event.bubbles,
          cancelable: event.cancelable,
          detail: (event as CustomEvent).detail,
          apiMethods: Object.keys(window.BugDrop ?? {}).sort(),
        });
      });
    });

    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const state = await page.evaluate(
      () =>
        (
          window as Window & {
            __bugdropReadyState?: {
              documentCount: number;
              events: Array<Record<string, unknown>>;
            };
          }
        ).__bugdropReadyState
    );
    expect(state).toEqual({
      documentCount: 0,
      events: [
        {
          targetIsWindow: true,
          bubbles: false,
          cancelable: false,
          detail: null,
          apiMethods: [
            'close',
            'hide',
            'isButtonVisible',
            'isOpen',
            'open',
            'registerFlow',
            'registerVariant',
            'setTheme',
            'show',
          ],
        },
      ],
    });
  });

  test('legacy API methods remain detachable and ignore extra arguments', async ({ page }) => {
    await page.route('**/api/check**', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"installed":true}' })
    );
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const openResult = await page.evaluate(() => {
      const { open } = window.BugDrop!;
      return (open as (...arguments_: unknown[]) => unknown)('future-instance-id', {
        ignored: true,
      });
    });
    expect(openResult).toBeUndefined();
    await expect(page.locator('#bugdrop-host').locator('css=.bd-modal')).toBeVisible();

    const closeResult = await page.evaluate(() => {
      const { close } = window.BugDrop!;
      return (close as (...arguments_: unknown[]) => unknown)('future-instance-id');
    });
    expect(closeResult).toBeUndefined();
    await expect(page.locator('#bugdrop-host').locator('css=.bd-modal')).not.toBeVisible();
  });

  test('does no variant-only work before any future variant registration', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const variantWork = await page.evaluate(() => ({
      ownedRoots: document.querySelectorAll('[data-bugdrop-owned]').length,
      storageKeys: Object.keys(localStorage).filter(key => key.startsWith('bugdrop_variant_')),
    }));
    expect(variantWork).toEqual({ ownedRoots: 0, storageKeys: [] });
  });

  test('registers multiple isolated variants and submits exact headless drafts', async ({
    page,
  }) => {
    const submitted: Record<string, unknown>[] = [];
    await page.route('**/api/feedback', route => {
      submitted.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          issueNumber: 91,
          issueUrl: 'https://github.com/mean-weasel/bugdrop-widget-test/issues/91',
          isPublic: true,
        }),
      });
    });
    await page.goto('/test/?private=redacted#secret');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const result = await page.evaluate(async () => {
      const source: Parameters<NonNullable<typeof window.BugDrop>['registerVariant']>[0] = {
        id: 'export-review',
        presentation: { kind: 'inline' },
        content: { title: 'Export review' },
        fields: [
          { id: 'rating', type: 'rating', label: 'Rating', required: true, scale: 5 },
          { id: 'message', type: 'longText', label: 'Comment' },
        ],
        issue: {
          classification: 'feedback',
          title: 'Review {{rating}}/5',
          sections: [
            { heading: 'Rating', field: 'rating', format: 'stars' },
            { heading: 'Comment', field: 'message', omitWhenEmpty: true },
          ],
        },
      };
      const handle = window.BugDrop!.registerVariant(source);
      const ctaHandle = window.BugDrop!.registerVariant({
        id: 'cloud-provider-idea',
        presentation: { kind: 'modal' },
        content: { title: 'Which cloud provider should we add?' },
        fields: [{ id: 'idea', type: 'shortText', label: 'Provider', required: true }],
        issue: {
          classification: 'feature',
          title: 'Cloud provider idea: {{idea}}',
          sections: [{ heading: 'Idea', field: 'idea' }],
        },
      });
      source.issue.title = 'mutated {{message}}';
      let duplicateError = '';
      try {
        window.BugDrop!.registerVariant(source);
      } catch (error) {
        duplicateError = error instanceof Error ? error.message : String(error);
      }
      const submission = await handle.submit(
        { rating: 5, message: '' },
        { submissionId: 'e2e-submission-1' }
      );
      const ctaSubmission = await ctaHandle.submit(
        { idea: 'Google Cloud' },
        { submissionId: 'e2e-submission-2' }
      );
      return {
        id: handle.id,
        submission,
        ctaId: ctaHandle.id,
        ctaSubmission,
        duplicateError,
        ownedRoots: document.querySelectorAll('[data-bugdrop-owned]').length,
        variantStorage: Object.keys(localStorage).filter(key => key.startsWith('bugdrop_variant_')),
      };
    });

    expect(result).toEqual({
      id: 'export-review',
      submission: {
        issueNumber: 91,
        issueUrl: 'https://github.com/mean-weasel/bugdrop-widget-test/issues/91',
        isPublic: true,
      },
      ctaId: 'cloud-provider-idea',
      ctaSubmission: {
        issueNumber: 91,
        issueUrl: 'https://github.com/mean-weasel/bugdrop-widget-test/issues/91',
        isPublic: true,
      },
      duplicateError: 'BugDrop variant is already registered: export-review',
      ownedRoots: 0,
      variantStorage: [],
    });
    expect(submitted).toHaveLength(2);
    expect(submitted[0]).toMatchObject({
      kind: 'bugdrop.variant-submission',
      schemaVersion: 1,
      repo: 'mean-weasel/bugdrop-widget-test',
      variantId: 'export-review',
      submissionId: 'e2e-submission-1',
      issue: {
        title: 'Review 5/5',
        classification: 'feedback',
        sections: [{ heading: 'Rating', value: '★★★★★ (5/5)', format: 'text' }],
      },
      metadata: { url: 'http://localhost:8787/test/' },
    });
    expect(submitted[1]).toMatchObject({
      kind: 'bugdrop.variant-submission',
      schemaVersion: 1,
      repo: 'mean-weasel/bugdrop-widget-test',
      variantId: 'cloud-provider-idea',
      submissionId: 'e2e-submission-2',
      issue: {
        title: 'Cloud provider idea: Google Cloud',
        classification: 'feature',
        sections: [{ heading: 'Idea', value: 'Google Cloud', format: 'text' }],
      },
    });
    for (const payload of submitted) {
      expect(payload).not.toHaveProperty('labels');
      expect(payload).not.toHaveProperty('fields');
    }
  });

  test('simultaneous inline variants isolate answers, submission IDs, reset, disposal, and legacy state', async ({
    page,
  }) => {
    const submitted: Record<string, unknown>[] = [];
    await page.route('**/api/check**', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"installed":true}' })
    );
    await page.route('**/api/feedback', route => {
      submitted.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          issueNumber: 92,
          issueUrl: 'https://github.com/mean-weasel/bugdrop-widget-test/issues/92',
          isPublic: false,
        }),
      });
    });
    await page.goto('/test/');
    const legacyHost = page.locator('#bugdrop-host');
    await legacyHost.locator('css=.bd-trigger').waitFor();

    const identities = await page.evaluate(() => {
      const firstSlot = document.createElement('div');
      firstSlot.id = 'simultaneous-first';
      const secondSlot = document.createElement('div');
      secondSlot.id = 'simultaneous-second';
      document.body.append(firstSlot, secondSlot);
      const handle = window.BugDrop!.registerVariant({
        id: 'simultaneous-inline-poll',
        presentation: { kind: 'inline' },
        content: { title: 'Pick a provider', submitLabel: 'Submit vote' },
        fields: [
          {
            id: 'choice',
            type: 'singleChoice',
            label: 'Provider',
            required: true,
            options: [
              { value: 'one', label: 'One' },
              { value: 'two', label: 'Two' },
            ],
          },
          { id: 'detail', type: 'shortText', label: 'Detail' },
        ],
        issue: {
          title: 'Provider {{choice}}',
          sections: [
            { heading: 'Choice', field: 'choice', format: 'choice' },
            { heading: 'Detail', field: 'detail', omitWhenEmpty: true },
          ],
        },
      });
      const first = handle.mount(firstSlot, { initialAnswers: { choice: 'one' } });
      const second = handle.mount(secondSlot, { initialAnswers: { choice: 'two' } });
      const firstHost = firstSlot.querySelector<HTMLElement>('[data-bugdrop-owned]')!;
      const secondHost = secondSlot.querySelector<HTMLElement>('[data-bugdrop-owned]')!;
      const firstName =
        firstHost.shadowRoot!.querySelector<HTMLInputElement>('input[type="radio"]')!.name;
      const secondName =
        secondHost.shadowRoot!.querySelector<HTMLInputElement>('input[type="radio"]')!.name;
      (
        window as Window & {
          __simultaneous?: {
            first: { reset(): void; unmount(): void };
            second: { unmount(): void };
          };
        }
      ).__simultaneous = { first, second };
      return { firstName, secondName, firstId: first.instanceId, secondId: second.instanceId };
    });

    expect(identities.firstId).not.toBe(identities.secondId);
    expect(identities.firstName).not.toBe(identities.secondName);
    const first = page.locator('#simultaneous-first > [data-bugdrop-owned]');
    const second = page.locator('#simultaneous-second > [data-bugdrop-owned]');
    await first.getByRole('textbox', { name: 'Detail' }).fill('First answer');
    await second.getByRole('textbox', { name: 'Detail' }).fill('Second answer');
    await first.getByRole('button', { name: 'Submit vote' }).click();
    await second.getByRole('button', { name: 'Submit vote' }).click();
    await expect(first.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
    await expect(second.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
    expect(submitted).toHaveLength(2);
    expect(submitted[0]).toMatchObject({
      issue: {
        title: 'Provider one',
        sections: [
          { heading: 'Choice', value: 'One', format: 'text' },
          { heading: 'Detail', value: 'First answer', format: 'text' },
        ],
      },
    });
    expect(submitted[1]).toMatchObject({
      issue: {
        title: 'Provider two',
        sections: [
          { heading: 'Choice', value: 'Two', format: 'text' },
          { heading: 'Detail', value: 'Second answer', format: 'text' },
        ],
      },
    });
    expect(submitted[0]?.submissionId).not.toBe(submitted[1]?.submissionId);

    await page.evaluate(() =>
      (
        window as Window & {
          __simultaneous?: { first: { reset(): void } };
        }
      ).__simultaneous?.first.reset()
    );
    await expect(first.getByRole('radio', { name: 'One' })).toBeChecked();
    await expect(first.getByRole('textbox', { name: 'Detail' })).toHaveValue('');
    await expect(second.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
    await first.getByRole('button', { name: 'Submit vote' }).click();
    expect(submitted).toHaveLength(3);
    expect(submitted[2]?.submissionId).not.toBe(submitted[0]?.submissionId);

    await page.evaluate(() =>
      (
        window as Window & {
          __simultaneous?: { first: { unmount(): void } };
        }
      ).__simultaneous?.first.unmount()
    );
    await expect(first).toHaveCount(0);
    await expect(second).toHaveCount(1);

    await page.evaluate(() => window.BugDrop!.open());
    await expect(legacyHost.locator('css=.bd-modal')).toBeVisible();
    await expect(second).toHaveCount(1);
    await page.evaluate(() => window.BugDrop!.close());
    await expect(legacyHost.locator('css=.bd-modal')).not.toBeVisible();
    await page.evaluate(() =>
      (
        window as Window & {
          __simultaneous?: { second: { unmount(): void } };
        }
      ).__simultaneous?.second.unmount()
    );
    await expect(second).toHaveCount(0);
    await expect(page.locator('[data-bugdrop-owned]')).toHaveCount(0);
    await expect(legacyHost.locator('css=.bd-trigger')).toBeVisible();
  });

  test('rejects failed and noncanonical structured submission responses', async ({ page }) => {
    await page.route('**/api/feedback', route => {
      const payload = route.request().postDataJSON() as { submissionId?: string };
      if (payload.submissionId === 'bad-http') {
        return route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Submission rejected' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          issueNumber: 91,
          issueUrl: 'https://attacker.test/not-an-issue',
          isPublic: true,
        }),
      });
    });
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const errors = await page.evaluate(async () => {
      const handle = window.BugDrop!.registerVariant({
        id: 'failure-contract',
        presentation: { kind: 'inline' },
        content: { title: 'Failure contract' },
        fields: [{ id: 'message', type: 'shortText', label: 'Message', required: true }],
        issue: { title: 'Failure: {{message}}' },
      });
      const messages: string[] = [];
      for (const submissionId of ['bad-http', 'bad-result']) {
        try {
          await handle.submit({ message: 'test' }, { submissionId });
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error));
        }
      }
      return messages;
    });

    expect(errors).toEqual(['Submission rejected', 'BugDrop received an invalid Issue result']);
  });

  test('BugDrop.open() opens the modal', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Modal should not be visible initially
    const modalBefore = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modalBefore).not.toBeVisible();

    // Call open API
    await page.evaluate(() => window.BugDrop?.open());
    await page.locator('#bugdrop-host').locator('css=.bd-modal').waitFor();

    // Modal should now be visible
    const modalAfter = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modalAfter).toBeVisible();
  });

  test('BugDrop.close() closes the modal', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Open modal first
    await page.evaluate(() => window.BugDrop?.open());
    await page.locator('#bugdrop-host').locator('css=.bd-modal').waitFor();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible();

    // Close via API
    await page.evaluate(() => window.BugDrop?.close());
    await expect(page.locator('#bugdrop-host').locator('css=.bd-modal')).not.toBeVisible();

    // Modal should be gone
    await expect(modal).not.toBeVisible();
  });

  test('BugDrop.isOpen() returns correct state', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Should be false initially
    const isOpenBefore = await page.evaluate(() => window.BugDrop?.isOpen());
    expect(isOpenBefore).toBeFalsy();

    // Open modal
    await page.evaluate(() => window.BugDrop?.open());
    await page.locator('#bugdrop-host').locator('css=.bd-modal').waitFor();

    // Should be true now
    const isOpenAfter = await page.evaluate(() => window.BugDrop?.isOpen());
    expect(isOpenAfter).toBeTruthy();

    // Close modal
    await page.evaluate(() => window.BugDrop?.close());
    await expect(page.locator('#bugdrop-host').locator('css=.bd-modal')).not.toBeVisible();

    // Should be false again
    const isOpenFinal = await page.evaluate(() => window.BugDrop?.isOpen());
    expect(isOpenFinal).toBeFalsy();
  });

  test('BugDrop.hide() hides the floating button', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible();

    // Hide button
    await page.evaluate(() => window.BugDrop?.hide());

    // Button should be hidden
    await expect(trigger).not.toBeVisible();
  });

  test('BugDrop.show() shows the hidden button', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');

    // Hide then show
    await page.evaluate(() => window.BugDrop?.hide());
    await expect(trigger).not.toBeVisible();

    await page.evaluate(() => window.BugDrop?.show());
    await expect(trigger).toBeVisible();
  });

  test('BugDrop.isButtonVisible() returns correct state', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Should be true initially
    const isVisibleBefore = await page.evaluate(() => window.BugDrop?.isButtonVisible());
    expect(isVisibleBefore).toBeTruthy();

    // Hide button
    await page.evaluate(() => window.BugDrop?.hide());

    // Should be false now
    const isVisibleAfter = await page.evaluate(() => window.BugDrop?.isButtonVisible());
    expect(isVisibleAfter).toBeFalsy();

    // Show button
    await page.evaluate(() => window.BugDrop?.show());

    // Should be true again
    const isVisibleFinal = await page.evaluate(() => window.BugDrop?.isButtonVisible());
    expect(isVisibleFinal).toBeTruthy();
  });
});

test.describe('Custom Accent Color', () => {
  test('default color is teal when data-color is not set', async ({ page }) => {
    await page.goto('/test/color-default.html');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Get the background color of the button
    const bgColor = await trigger.evaluate(el => getComputedStyle(el).backgroundColor);

    // Default dark theme color is #22d3ee (rgb(34, 211, 238))
    // Parse RGB values
    const rgbMatch = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(rgbMatch).not.toBeNull();

    if (rgbMatch) {
      const [, r, g, b] = rgbMatch.map(Number);
      // Teal/cyan has high green and blue, low red
      expect(r).toBeLessThan(100); // Low red
      expect(g).toBeGreaterThan(150); // High green
      expect(b).toBeGreaterThan(200); // High blue
    }
  });

  test('custom color is applied when data-color is set', async ({ page }) => {
    await page.goto('/test/color-custom.html');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Get the background color of the button
    const bgColor = await trigger.evaluate(el => getComputedStyle(el).backgroundColor);

    // Custom color is #9333EA (purple) = rgb(147, 51, 234)
    const rgbMatch = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(rgbMatch).not.toBeNull();

    if (rgbMatch) {
      const [, r, g, b] = rgbMatch.map(Number);
      // Purple has medium red, low green, high blue
      expect(r).toBeGreaterThan(100); // Medium-high red
      expect(g).toBeLessThan(100); // Low green
      expect(b).toBeGreaterThan(200); // High blue
    }
  });

  test('custom color applies to focus ring on form inputs', async ({ page }) => {
    // Mock the installation check to return installed: true
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/color-custom.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Open modal
    await trigger.click();

    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click "Get Started" on welcome screen
    const getStartedBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    // Focus on title input
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.focus();

    // Check that the --bd-border-focus CSS variable is set to the custom color
    const root = page.locator('#bugdrop-host').locator('css=.bd-root');
    const borderFocusColor = await root.evaluate(el =>
      getComputedStyle(el).getPropertyValue('--bd-border-focus').trim()
    );

    // Should be the custom purple color
    expect(borderFocusColor).toBe('#9333EA');
  });

  test('custom color persists after modal interactions', async ({ page }) => {
    await page.goto('/test/color-custom.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Open and close modal
    await trigger.click();
    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-close');
    await closeBtn.click();
    await expect(modal).not.toBeVisible();

    // Button should still have custom color
    const bgColor = await trigger.evaluate(el => getComputedStyle(el).backgroundColor);
    const rgbMatch = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(rgbMatch).not.toBeNull();

    if (rgbMatch) {
      const [, r, g, b] = rgbMatch.map(Number);
      // Still purple
      expect(r).toBeGreaterThan(100);
      expect(g).toBeLessThan(100);
      expect(b).toBeGreaterThan(200);
    }
  });
});

test.describe('Pull Tab Restore', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test/dismissible.html');
    await page.evaluate(() => localStorage.removeItem('bugdrop_dismissed'));
  });

  test('pull tab appears after dismissing the button', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Pull tab should not exist initially
    const pullTab = page.locator('#bugdrop-host').locator('css=.bd-pull-tab');
    await expect(pullTab).not.toBeAttached();

    // Dismiss the button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();

    // Pull tab should now be visible
    await expect(pullTab).toBeVisible({ timeout: 2000 });
  });

  test('clicking pull tab restores the feedback button', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Dismiss the button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();

    // Click the pull tab
    const pullTab = page.locator('#bugdrop-host').locator('css=.bd-pull-tab');
    await expect(pullTab).toBeVisible({ timeout: 2000 });
    await pullTab.click();

    // Button should be visible again
    const triggerAfterRestore = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(triggerAfterRestore).toBeVisible({ timeout: 2000 });

    // Pull tab should be gone
    await expect(pullTab).not.toBeAttached();
  });

  test('pull tab restore clears localStorage dismissed state', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Dismiss the button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();
    await expect(trigger).not.toBeAttached({ timeout: 2000 });

    // Verify localStorage is set
    const dismissedBefore = await page.evaluate(() => localStorage.getItem('bugdrop_dismissed'));
    expect(dismissedBefore).not.toBeNull();

    // Click the pull tab
    const pullTab = page.locator('#bugdrop-host').locator('css=.bd-pull-tab');
    await expect(pullTab).toBeVisible({ timeout: 2000 });
    await pullTab.click();
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // localStorage should be cleared
    const dismissedAfter = await page.evaluate(() => localStorage.getItem('bugdrop_dismissed'));
    expect(dismissedAfter).toBeNull();
  });

  test('restored button is fully functional', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Dismiss and restore
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();
    await expect(trigger).not.toBeAttached({ timeout: 2000 });

    const pullTab = page.locator('#bugdrop-host').locator('css=.bd-pull-tab');
    await expect(pullTab).toBeVisible({ timeout: 2000 });
    await pullTab.click();
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Click the restored button to open modal
    const restoredTrigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await restoredTrigger.click();

    // Modal should open
    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });
  });

  test('restored button can be dismissed again', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // First dismiss
    await trigger.hover();
    let closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();
    await expect(trigger).not.toBeAttached({ timeout: 2000 });

    // Restore via pull tab
    const pullTab = page.locator('#bugdrop-host').locator('css=.bd-pull-tab');
    await expect(pullTab).toBeVisible({ timeout: 2000 });
    await pullTab.click();
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Second dismiss
    const restoredTrigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await restoredTrigger.hover();
    closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();

    // Button should be gone, pull tab should reappear
    await expect(restoredTrigger).not.toBeAttached({ timeout: 5000 });
    const pullTabAgain = page.locator('#bugdrop-host').locator('css=.bd-pull-tab');
    await expect(pullTabAgain).toBeVisible({ timeout: 2000 });
  });

  test('pull tab is keyboard accessible', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Dismiss the button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();
    await expect(trigger).not.toBeAttached({ timeout: 2000 });

    // Focus the pull tab and press Enter
    const pullTab = page.locator('#bugdrop-host').locator('css=.bd-pull-tab');
    await expect(pullTab).toBeVisible({ timeout: 2000 });
    await pullTab.focus();
    await page.keyboard.press('Enter');

    // Button should be restored
    const restoredTrigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(restoredTrigger).toBeVisible({ timeout: 2000 });
  });

  test('pull tab persists after page reload', async ({ page }) => {
    await page.goto('/test/dismissible.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Dismiss the button
    await trigger.hover();
    const closeBtn = page.locator('#bugdrop-host').locator('css=.bd-trigger-close');
    await expect(closeBtn).toHaveCSS('opacity', '1', { timeout: 2000 });
    await closeBtn.click();
    await expect(trigger).not.toBeAttached({ timeout: 2000 });

    // Reload page
    await page.reload();
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });

    // Button should still be hidden
    const triggerAfterReload = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(triggerAfterReload).not.toBeAttached();

    // Pull tab should be visible
    const pullTab = page.locator('#bugdrop-host').locator('css=.bd-pull-tab');
    await expect(pullTab).toBeVisible();
  });
});

test.describe('API-Only Mode (data-button="false")', () => {
  test('floating button is not rendered when data-button="false"', async ({ page }) => {
    await page.goto('/test/api-only.html');
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });

    // Button should not exist
    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).not.toBeAttached();
  });

  test('BugDrop API is still available in API-only mode', async ({ page }) => {
    await page.goto('/test/api-only.html');
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });

    const hasBugDrop = await page.evaluate(() => {
      return typeof window.BugDrop === 'object' && window.BugDrop !== null;
    });
    expect(hasBugDrop).toBeTruthy();
  });

  test('BugDrop.open() works in API-only mode', async ({ page }) => {
    await page.goto('/test/api-only.html');
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });

    // Open modal via API
    await page.evaluate(() => window.BugDrop?.open());
    await page.locator('#bugdrop-host').locator('css=.bd-modal').waitFor();

    // Modal should be visible
    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible();
  });

  test('BugDrop.isButtonVisible() returns false in API-only mode', async ({ page }) => {
    await page.goto('/test/api-only.html');
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });

    const isVisible = await page.evaluate(() => window.BugDrop?.isButtonVisible());
    expect(isVisible).toBeFalsy();
  });

  test('custom button can trigger BugDrop.open()', async ({ page }) => {
    await page.goto('/test/api-only.html');

    // Wait for BugDrop to be ready
    await page.waitForFunction(
      () => {
        const status = document.getElementById('status');
        return status?.textContent?.includes('BugDrop ready');
      },
      { timeout: 5000 }
    );

    // Click the "Report Bug" link in the nav
    await page.click('#nav-report-bug');

    // Modal should open
    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });
  });

  test('BugDrop.show() does nothing in API-only mode (no button to show)', async ({ page }) => {
    await page.goto('/test/api-only.html');
    await page.locator('#bugdrop-host').waitFor({ state: 'attached' });

    // Try to show button (should do nothing, no errors)
    await page.evaluate(() => window.BugDrop?.show());

    // Button should still not exist
    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).not.toBeAttached();
  });
});

test.describe('Feedback Categories', () => {
  test('category selector is visible on feedback form', async ({ page }) => {
    // Mock installation check
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/index.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Click to open modal
    await trigger.click();
    const modal = page.locator('#bugdrop-host').locator('css=.bd-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click continue on welcome screen
    const continueBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await continueBtn.click();

    // Wait for form to appear by checking for title input
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // Category selector should be visible
    const categorySelector = page.locator('#bugdrop-host').locator('css=.bd-category-selector');
    await expect(categorySelector).toBeVisible();

    // All three options should be present
    const bugOption = page
      .locator('#bugdrop-host')
      .locator('css=input[name="category"][value="bug"]');
    const featureOption = page
      .locator('#bugdrop-host')
      .locator('css=input[name="category"][value="feature"]');
    const questionOption = page
      .locator('#bugdrop-host')
      .locator('css=input[name="category"][value="question"]');

    await expect(bugOption).toBeAttached();
    await expect(featureOption).toBeAttached();
    await expect(questionOption).toBeAttached();
  });

  test('feedback form fields progress from category to details and submitter info', async ({
    page,
  }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/test/?showName=true&showEmail=true');

    const host = page.locator('#bugdrop-host');
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await expect(host.locator('css=#title')).toBeVisible({ timeout: 5000 });

    const fieldOrder = await host.locator('css=#feedback-form').evaluate(form =>
      Array.from(form.children)
        .map(child => {
          if (!(child instanceof HTMLElement)) return null;
          if (child.querySelector('.bd-category-selector')) return 'category';
          if (child.querySelector('#title')) return 'title';
          if (child.querySelector('#description')) return 'description';
          if (child.querySelector('#name')) return 'name';
          if (child.querySelector('#email')) return 'email';
          if (child.querySelector('#include-screenshot')) return 'screenshot';
          if (child.classList.contains('bd-actions')) return 'actions';
          return null;
        })
        .filter(Boolean)
    );

    expect(fieldOrder).toEqual([
      'category',
      'title',
      'description',
      'name',
      'email',
      'screenshot',
      'actions',
    ]);

    const formFields = [
      host.locator('css=.bd-category-selector'),
      host.locator('css=#title'),
      host.locator('css=#description'),
      host.locator('css=#name'),
      host.locator('css=#email'),
      host.locator('css=#include-screenshot'),
    ];
    const boxes = await Promise.all(formFields.map(locator => locator.boundingBox()));

    expect(boxes.every(Boolean)).toBe(true);
    for (let i = 1; i < boxes.length; i += 1) {
      expect(boxes[i]!.y).toBeGreaterThan(boxes[i - 1]!.y);
    }

    const categoryBox = await host.locator('css=.bd-category-selector').boundingBox();
    expect(categoryBox?.height).toBeLessThan(60);
  });

  test('bug category is selected by default', async ({ page }) => {
    // Mock installation check
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/index.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();
    await page.locator('#bugdrop-host').locator('css=.bd-modal').waitFor();

    const continueBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await continueBtn.click();

    // Wait for form to appear
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // Bug should be checked by default
    const bugOption = page
      .locator('#bugdrop-host')
      .locator('css=input[name="category"][value="bug"]');
    await expect(bugOption).toBeChecked();
  });

  test('can select different categories', async ({ page }) => {
    // Mock installation check
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });

    await page.goto('/test/index.html');

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();
    await page.locator('#bugdrop-host').locator('css=.bd-modal').waitFor();

    const continueBtn = page.locator('#bugdrop-host').locator('css=[data-action="continue"]');
    await continueBtn.click();

    // Wait for form to appear
    const titleInput = page.locator('#bugdrop-host').locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // Select feature
    const featureOption = page
      .locator('#bugdrop-host')
      .locator('css=input[name="category"][value="feature"]');
    await featureOption.click();
    await expect(featureOption).toBeChecked();

    // Bug should no longer be checked
    const bugOption = page
      .locator('#bugdrop-host')
      .locator('css=input[name="category"][value="bug"]');
    await expect(bugOption).not.toBeChecked();

    // Select question
    const questionOption = page
      .locator('#bugdrop-host')
      .locator('css=input[name="category"][value="question"]');
    await questionOption.click();
    await expect(questionOption).toBeChecked();
    await expect(featureOption).not.toBeChecked();
  });
});

test.describe('Custom Icon', () => {
  test('custom icon renders img element with correct src', async ({ page }) => {
    await page.goto('/test/icon-custom.html');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const trigger = page.locator('#bugdrop-host').locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    // Should have an img inside the trigger icon
    const img = page.locator('#bugdrop-host').locator('css=.bd-trigger-icon img');
    await expect(img).toBeVisible();

    // Img src should contain the same-origin icon URL
    const src = await img.getAttribute('src');
    expect(src).toContain('/test/bugdrop-icon.svg');
  });

  test('hostile label and icon config cannot inject markup', async ({ page }) => {
    await page.goto('/test/index.html');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    await page.evaluate(() => {
      document.getElementById('bugdrop-host')?.remove();

      const script = document.createElement('script');
      script.src = '/widget.js';
      script.dataset.repo = 'mean-weasel/bugdrop-widget-test';
      script.dataset.label = '<img src=x onerror="window.__bugdropLabelXss = true">';
      script.dataset.icon = 'javascript:window.__bugdropIconXss = true';
      document.body.appendChild(script);
    });

    const host = page.locator('#bugdrop-host');
    const trigger = host.locator('css=.bd-trigger');
    await expect(trigger).toBeVisible({ timeout: 5000 });

    await expect(host.locator('css=.bd-trigger-label img')).not.toBeAttached();
    await expect(host.locator('css=.bd-trigger-icon img')).not.toBeAttached();
    await expect(host.locator('css=.bd-trigger-label')).toHaveText(
      '<img src=x onerror="window.__bugdropLabelXss = true">'
    );

    const executed = await page.evaluate(() => ({
      label: Boolean((window as typeof window & { __bugdropLabelXss?: boolean }).__bugdropLabelXss),
      icon: Boolean((window as typeof window & { __bugdropIconXss?: boolean }).__bugdropIconXss),
    }));
    expect(executed).toEqual({ label: false, icon: false });
  });

  test('broken icon URL falls back to default emoji', async ({ page }) => {
    // Navigate to a page and inject widget with broken icon URL
    await page.goto('/test/icon-custom.html');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    // Modify the page to use a broken URL by evaluating script
    await page.evaluate(() => {
      const host = document.getElementById('bugdrop-host');
      if (host) host.remove();

      const script = document.createElement('script');
      script.src = '/widget.js';
      script.dataset.repo = 'mean-weasel/bugdrop-widget-test';
      script.dataset.theme = 'dark';
      script.dataset.icon = 'https://invalid.example.com/nonexistent.png';
      document.body.appendChild(script);
    });

    const triggerIcon = page.locator('#bugdrop-host').locator('css=.bd-trigger-icon');
    await expect(triggerIcon).toBeVisible({ timeout: 5000 });

    // The img should be hidden (display:none from onerror) and fallback emoji visible
    const fallbackText = await triggerIcon.textContent();
    expect(fallbackText).toContain('🐛');
  });

  test('default emoji shows when no data-icon is set', async ({ page }) => {
    await page.goto('/test/index.html');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();

    const triggerIcon = page.locator('#bugdrop-host').locator('css=.bd-trigger-icon');
    await expect(triggerIcon).toBeVisible({ timeout: 5000 });

    // Should NOT have an img element
    const img = page.locator('#bugdrop-host').locator('css=.bd-trigger-icon img');
    await expect(img).not.toBeAttached();

    // Should have the default emoji
    const text = await triggerIcon.textContent();
    expect(text).toContain('🐛');
  });
});

test.describe('Screenshot Crash Prevention (#67)', () => {
  const STUB_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  // Mock toPng via the widget's __bugdropMockToPng test seam (addInitScript
  // runs before the bundled IIFE, so the mock is in place when captureScreenshot fires)
  function mockHtmlToImage(page: Page, toPngBody: string) {
    return page.addInitScript(`window.__bugdropMockToPng = ${toPngBody};`);
  }

  // Spy mock: records opts and returns a valid PNG
  function spyToPng() {
    return `function(el, opts) {
      window.__captureOpts = opts;
      return Promise.resolve('${STUB_PNG}');
    }`;
  }

  function targetSpyToPng() {
    return `function(el, opts) {
      window.__captureOpts = opts;
      var rect = el.getBoundingClientRect();
      window.__captureTargetInfo = {
        tagName: el.tagName,
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className : '',
        width: rect.width,
        height: rect.height
      };
      return Promise.resolve('${STUB_PNG}');
    }`;
  }

  function redactionAwarePng() {
    return `function(el, opts) {
      window.__captureOpts = opts;
      var canvas = document.createElement('canvas');
      var pixelRatio = opts && opts.pixelRatio ? opts.pixelRatio : 1;
      canvas.width = Math.max(1, Math.ceil((opts && opts.width ? opts.width : document.documentElement.scrollWidth) * pixelRatio));
      canvas.height = Math.max(1, Math.ceil((opts && opts.height ? opts.height : document.documentElement.scrollHeight) * pixelRatio));
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return Promise.resolve(canvas.toDataURL('image/png'));
    }`;
  }

  function mockGetDisplayMedia(page: Page, body: string) {
    return page.addInitScript(`
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getDisplayMedia: ${body}
        },
        configurable: true
      });
    `);
  }

  function reporterLikePng(
    variant: 'preview-size' | 'small-wide-area' | 'annotation-style' | 'undo'
  ) {
    return `function(el, opts) {
      window.__captureOpts = opts;
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      if ('${variant}' === 'preview-size') {
        canvas.width = 1040;
        canvas.height = 260;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#111827';
        ctx.font = '600 16px Arial';
        ctx.fillText('Widget', 36, 34);
        ctx.fillStyle = '#4b5563';
        ctx.font = '13px Arial';
        ctx.fillText('Password Widget v2', 36, 68);
        ctx.fillText('Preview settings are represented here with small but readable text.', 36, 98);
        ctx.fillStyle = '#f3f4f6';
        ctx.fillRect(36, 120, 420, 24);
        ctx.fillStyle = '#6b7280';
        ctx.fillText('Location Widget #3', 48, 137);
        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(36, 160, 520, 34);
        ctx.fillStyle = '#374151';
        ctx.fillText('Object: example.company/feature/preview', 48, 181);
      } else if ('${variant}' === 'small-wide-area') {
        canvas.width = 252;
        canvas.height = 54;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#525252';
        ctx.font = '28px Arial';
        ctx.fillText('Settlement Stage', 14, 36);
      } else if ('${variant}' === 'undo') {
        canvas.width = 600;
        canvas.height = 300;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#111827';
        ctx.font = '600 18px Arial';
        ctx.fillText('Undo regression canvas', 24, 38);
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(36, 82, 210, 128);
        ctx.fillRect(354, 82, 210, 128);
        ctx.fillStyle = '#6b7280';
        ctx.font = '14px Arial';
        ctx.fillText('First annotation area', 58, 150);
        ctx.fillText('Latest annotation area', 374, 150);
      } else {
        canvas.width = 1024;
        canvas.height = 252;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#2f2f2f';
        ctx.font = '500 16px Arial';
        ctx.fillText('Shipmen Overview', 24, 28);
        var labels = ['Schedule Stage', 'Weight Stage', 'Settlement Stage', 'Amount Stage'];
        var values = ['30-04-2026\\nForecasted', '25.000t\\nForecasted', "1'817.24\\nEUR/t\\nFinal", "45'431.03\\nEUR\\nForecasted"];
        var xs = [24, 260, 520, 770];
        labels.forEach(function(label, index) {
          ctx.fillStyle = '#4a4a4a';
          ctx.font = '14px Arial';
          ctx.fillText(label, xs[index], 72);
          ctx.fillStyle = '#f5f5f5';
          ctx.fillRect(xs[index], 86, 128, 66);
          ctx.fillStyle = index === 2 ? '#35a36d' : '#ef4444';
          ctx.beginPath();
          ctx.arc(xs[index] + 14, 106, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#777777';
          ctx.font = '600 14px Arial';
          values[index].split('\\n').forEach(function(line, lineIndex) {
            ctx.fillText(line, xs[index] + 28, 104 + lineIndex * 18);
          });
          ctx.fillStyle = '#8a8a8a';
          ctx.font = '13px Arial';
          ctx.fillText('Auto-derived status text for comparison', xs[index], 176);
        });
      }
      return Promise.resolve(canvas.toDataURL('image/png'));
    }`;
  }

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });
  });

  // Helper: open widget, click through welcome, fill title — returns the host locator
  async function navigateToForm(page: Page, title = 'Screenshot test') {
    const host = page.locator('#bugdrop-host');

    const button = host.locator('css=.bd-trigger');
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();

    const getStartedBtn = host.locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill(title);

    return host;
  }

  // Helper: navigate widget to screenshot options and return the host locator
  async function navigateToScreenshotOptions(page: Page) {
    const host = await navigateToForm(page);

    const screenshotCheckbox = host.locator('css=#include-screenshot');
    await screenshotCheckbox.check();

    const continueBtn = host.locator('css=#submit-btn');
    await continueBtn.click();

    await expect(host.locator('css=[data-action="element"]')).toBeVisible({ timeout: 5000 });
    return host;
  }

  // Helper: navigate to screenshot options and click "Full Page"
  async function navigateToFullPageCapture(page: Page) {
    const host = await navigateToScreenshotOptions(page);
    const captureBtn = host.locator('css=[data-action="capture"]');
    await expect(captureBtn).toBeVisible({ timeout: 5000 });
    await captureBtn.click();
  }

  async function captureElementForAnnotation(page: Page, path: string, selector: string) {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(path);

    const host = await navigateToScreenshotOptions(page);
    const elementBtn = host.locator('css=[data-action="element"]');
    await expect(elementBtn).toBeVisible({ timeout: 5000 });
    await elementBtn.click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });

    const target = page.locator(selector);
    await expect(target).toBeVisible({ timeout: 5000 });
    const targetBox = await target.boundingBox();
    expect(targetBox).toBeTruthy();
    const targetX = targetBox!.x + targetBox!.width / 2;
    const targetY = targetBox!.y + targetBox!.height / 2;
    await page.mouse.move(targetX, targetY);
    await page.mouse.click(targetX, targetY);

    const modal = host.locator('css=.bd-modal--annotator');
    const stage = host.locator('css=#annotation-canvas');
    const canvas = stage.locator('css=canvas');
    await expect(modal).toBeVisible({ timeout: 30000 });
    await expect(stage).toBeVisible();
    await expect(canvas).toBeVisible();

    return { host, modal, stage, canvas };
  }

  async function trackFeedbackSubmissions(page: Page) {
    let count = 0;
    await page.route('**/feedback', async route => {
      count++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });
    return () => count;
  }

  test('full-page capture excludes owned variants', async ({ page }) => {
    await mockHtmlToImage(
      page,
      `function(el, opts) {
        window.__captureOpts = opts;
        window.__ownedCaptureFilter = Array.from(document.querySelectorAll('[data-bugdrop-owned]'))
          .map(function(root) { return opts.filter(root); });
        return Promise.resolve('${STUB_PNG}');
      }`
    );
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();
    await page.evaluate(() => {
      for (const rating of [1, 5]) {
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        window
          .BugDrop!.registerVariant({
            id: `capture-review-${rating}`,
            presentation: { kind: 'inline' },
            content: { title: 'Capture review' },
            fields: [{ id: 'rating', type: 'rating', label: 'Rating' }],
            issue: { title: 'Capture {{rating}}' },
          })
          .mount(slot, { initialAnswers: { rating } });
      }
    });

    await navigateToFullPageCapture(page);
    await expect
      .poll(() => page.evaluate(() => window.__ownedCaptureFilter))
      .toEqual([false, false]);
  });

  test('element picker excludes owned variants', async ({ page }) => {
    await page.goto('/test/');
    await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor();
    await page.evaluate(() => {
      const underlay = document.createElement('div');
      underlay.id = 'capture-underlay';
      Object.assign(underlay.style, { width: '500px', minHeight: '260px', padding: '20px' });
      document.body.prepend(underlay);
      window
        .BugDrop!.registerVariant({
          id: 'picker-review',
          presentation: { kind: 'inline' },
          content: { title: 'Picker review' },
          fields: [{ id: 'rating', type: 'rating', label: 'Rating' }],
          issue: { title: 'Picker {{rating}}' },
        })
        .mount(underlay, { initialAnswers: { rating: 3 } });
    });
    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible();
    const variant = page.locator('#capture-underlay > [data-bugdrop-owned]');
    const box = await variant.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const highlight = page.locator('#bugdrop-element-picker-highlight');
    await expect(highlight).toBeVisible();
    const highlightBox = await highlight.boundingBox();
    const underlayBox = await page.locator('#capture-underlay').boundingBox();
    expect(highlightBox).not.toBeNull();
    expect(underlayBox).not.toBeNull();
    expect(Math.abs(highlightBox!.width - underlayBox!.width)).toBeLessThanOrEqual(12);
    expect(Math.abs(highlightBox!.height - underlayBox!.height)).toBeLessThanOrEqual(12);
    expect(highlightBox!.width).toBeGreaterThan(box!.width);
    await page.keyboard.press('Escape');
    await expect(page.locator('#bugdrop-element-picker-overlay')).toHaveCount(0);
  });

  async function trackFeedbackPayloads(page: Page) {
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

  async function expectReturnedToForm(host: ReturnType<Page['locator']>, title: string) {
    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await expect(titleInput).toHaveValue(title);
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

  async function submitWithIssueResponse(page: Page, path: string, isPublic: boolean) {
    const issueUrl = 'https://github.com/example/project/issues/496';

    await page.route('**/feedback', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          issueNumber: 496,
          issueUrl,
          isPublic,
        }),
      });
    });

    await page.goto(path);
    const host = await navigateToForm(page, 'Private repo link test');

    await host.locator('css=#include-screenshot').uncheck();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    return { host, issueUrl };
  }

  test('keeps private repo issue links hidden by default', async ({ page }) => {
    const { host } = await submitWithIssueResponse(page, '/test/', false);

    await expect(host.locator('css=.bd-success-issue')).toContainText(
      'Your feedback has been submitted successfully.'
    );
    await expect(host.locator('css=.bd-issue-link')).toHaveCount(0);
  });

  test('shows public repo issue links by default', async ({ page }) => {
    const { host, issueUrl } = await submitWithIssueResponse(page, '/test/', true);

    await expect(host.locator('css=.bd-success-issue')).toContainText('Issue #496');

    const issueLink = host.locator('css=.bd-issue-link');
    await expect(issueLink).toBeVisible();
    await expect(issueLink).toHaveAttribute('href', issueUrl);
  });

  test('shows private repo issue link when configured to always show issue links', async ({
    page,
  }) => {
    const { host, issueUrl } = await submitWithIssueResponse(
      page,
      '/test/?showIssueLink=always',
      false
    );

    await expect(host.locator('css=.bd-success-issue')).toContainText('Issue #496');

    const issueLink = host.locator('css=.bd-issue-link');
    await expect(issueLink).toBeVisible();
    await expect(issueLink).toHaveAttribute('href', issueUrl);
    await expect(issueLink).toHaveAttribute('target', '_blank');
  });

  test('hides public repo issue link when configured to never show issue links', async ({
    page,
  }) => {
    const { host } = await submitWithIssueResponse(page, '/test/?showIssueLink=never', true);

    await expect(host.locator('css=.bd-success-issue')).toContainText('Issue #496');
    await expect(host.locator('css=.bd-issue-link')).toHaveCount(0);
  });

  test('sends custom category label mapping while keeping built-in category UI', async ({
    page,
  }) => {
    const payloads = await trackFeedbackPayloads(page);
    const categoryLabels = encodeURIComponent(
      JSON.stringify({
        bug: ['defect', 'frontend'],
        feature: 'product-feedback',
        question: 'support',
      })
    );

    await page.goto(`/test/?categoryLabels=${categoryLabels}`);
    const host = await navigateToForm(page, 'Custom label mapping test');

    await expect(host.locator('css=input[name="category"][value="bug"]')).toBeAttached();
    await expect(host.locator('css=input[name="category"][value="feature"]')).toBeAttached();
    await expect(host.locator('css=input[name="category"][value="question"]')).toBeAttached();

    await host.locator('css=input[name="category"][value="feature"]').click();
    await host.locator('css=#include-screenshot').uncheck();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    expect(payloads[0]?.category).toBe('feature');
    expect(payloads[0]?.categoryLabels).toEqual({
      bug: ['defect', 'frontend'],
      feature: 'product-feedback',
      question: 'support',
    });
  });

  test('malformed category label mapping does not block submission', async ({ page }) => {
    const payloads = await trackFeedbackPayloads(page);
    const warnings: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });

    await page.goto('/test/?categoryLabels=%7Bbad-json');
    const host = await navigateToForm(page, 'Malformed label mapping test');

    await host.locator('css=#include-screenshot').uncheck();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    expect(payloads[0]?.category).toBe('bug');
    expect(payloads[0]?.categoryLabels).toBeUndefined();
    expect(warnings.some(w => w.startsWith('[BugDrop] Invalid data-category-labels'))).toBe(true);
  });

  async function countAnnotationPixels(canvas: ReturnType<Page['locator']>) {
    return canvas.evaluate(el => {
      const source = el as HTMLCanvasElement;
      const ctx = source.getContext('2d');
      if (!ctx) {
        throw new Error('Missing canvas context');
      }

      const { data } = ctx.getImageData(0, 0, source.width, source.height);
      let red = 0;
      let orange = 0;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        if (a > 200 && r > 220 && g < 80 && b < 80) {
          red++;
        }

        if (a > 200 && r > 245 && g > 140 && g < 180 && b > 80 && b < 120) {
          orange++;
        }
      }

      return { red, orange };
    });
  }

  async function countRedPixelsInRegion(
    canvas: ReturnType<Page['locator']>,
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
    canvas: ReturnType<Page['locator']>,
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

  async function countRedPixelsInDataUrl(
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
      },
      { dataUrl, region }
    );
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
    canvas: ReturnType<Page['locator']>,
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

  test('reduces pixelRatio on complex DOM pages (>3000 nodes)', async ({ page }) => {
    await mockHtmlToImage(page, spyToPng());
    await page.goto('/test/complex-dom.html');

    // Verify the page actually has >3000 nodes
    const nodeCount = await page.evaluate(() => document.body.querySelectorAll('*').length);
    expect(nodeCount).toBeGreaterThan(3000);

    await navigateToFullPageCapture(page);

    // Wait for annotation step (capture succeeded)
    const annotationCanvas = page.locator('#bugdrop-host').locator('css=#annotation-canvas');
    await expect(annotationCanvas).toBeVisible({ timeout: 10000 });

    // Verify pixelRatio was reduced to 1 due to complex DOM
    const captureOpts = await page.evaluate(() => window.__captureOpts);
    expect(captureOpts).toBeDefined();
    if (!captureOpts) {
      throw new Error('Missing capture options');
    }
    expect(captureOpts.pixelRatio).toBe(1);
    expect(captureOpts.cacheBust).toBe(false);
    expect(captureOpts.imagePlaceholder).toMatch(/^data:image\/gif;base64,/);
  });

  test('uses normal pixelRatio on simple pages', async ({ page }) => {
    await mockHtmlToImage(page, spyToPng());
    await page.goto('/test/');

    // Verify simple page has <3000 nodes
    const nodeCount = await page.evaluate(() => document.body.querySelectorAll('*').length);
    expect(nodeCount).toBeLessThan(3000);

    await navigateToFullPageCapture(page);

    // Wait for annotation step
    const annotationCanvas = page.locator('#bugdrop-host').locator('css=#annotation-canvas');
    await expect(annotationCanvas).toBeVisible({ timeout: 10000 });

    // pixelRatio should be >= 2 (default min scale)
    const captureOpts = await page.evaluate(() => window.__captureOpts);
    expect(captureOpts).toBeDefined();
    if (!captureOpts) {
      throw new Error('Missing capture options');
    }
    expect(captureOpts.pixelRatio).toBeGreaterThanOrEqual(2);
  });

  test('no unhandled rejections after successful capture', async ({ page }) => {
    // Track unhandled promise rejections — verifies the timer is cleaned up
    const rejections: string[] = [];
    page.on('pageerror', err => rejections.push(err.message));

    await mockHtmlToImage(page, spyToPng());
    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    const annotationCanvas = page.locator('#bugdrop-host').locator('css=#annotation-canvas');
    await expect(annotationCanvas).toBeVisible({ timeout: 10000 });

    // Wait long enough for a leaked timer to fire (timeout is 15s, capture is instant)
    await page.waitForTimeout(2000);

    const timeoutRejections = rejections.filter(m => m.includes('timed out'));
    expect(timeoutRejections).toHaveLength(0);
  });

  test('element capture uses a surrounding context target', async ({ page }) => {
    await mockHtmlToImage(page, targetSpyToPng());
    await page.goto('/test/annotation-style.html?elementContextMaxArea=1.5');

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });

    const selected = page.locator('.dot.green');
    await expect(selected).toBeVisible();
    const selectedBox = await selected.boundingBox();
    expect(selectedBox).toBeTruthy();

    await page.mouse.click(
      selectedBox!.x + selectedBox!.width / 2,
      selectedBox!.y + selectedBox!.height / 2
    );

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });

    const targetInfo = await page.evaluate(() => window.__captureTargetInfo);
    expect(targetInfo).toBeDefined();
    if (!targetInfo) throw new Error('Missing capture target info');
    expect(targetInfo.className).not.toContain('dot');
    expect(targetInfo.width).toBeGreaterThan(selectedBox!.width * 4);
    expect(targetInfo.height).toBeGreaterThan(selectedBox!.height * 4);

    const captureOpts = await page.evaluate(() => window.__captureOpts);
    expect(captureOpts?.pixelRatio).toBe(1);

    const selectedElementNote = host.locator('css=.bd-selected-element-note');
    await expect(selectedElementNote).toContainText('data-element-context-max-area');
    await expect(selectedElementNote.locator('css=a')).toHaveAttribute(
      'href',
      'https://bugdrop.dev/docs/configuration#select-element-screenshots'
    );
  });

  test('element context max-area setting can keep captures tightly scoped', async ({ page }) => {
    await mockHtmlToImage(page, targetSpyToPng());
    await page.goto('/test/annotation-style.html?elementContextMaxArea=0');

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });

    const selected = page.locator('.dot.green');
    await expect(selected).toBeVisible();
    const selectedBox = await selected.boundingBox();
    expect(selectedBox).toBeTruthy();

    await page.mouse.click(
      selectedBox!.x + selectedBox!.width / 2,
      selectedBox!.y + selectedBox!.height / 2
    );

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });

    const targetInfo = await page.evaluate(() => window.__captureTargetInfo);
    expect(targetInfo).toBeDefined();
    if (!targetInfo) throw new Error('Missing capture target info');
    expect(targetInfo.className).toContain('dot');
    expect(targetInfo.width).toBeLessThanOrEqual(selectedBox!.width + 1);
    expect(targetInfo.height).toBeLessThanOrEqual(selectedBox!.height + 1);

    const captureOpts = await page.evaluate(() => window.__captureOpts);
    expect(captureOpts?.style).toBeUndefined();
  });

  test('real element capture keeps a centered target aligned to the full image width', async ({
    page,
  }) => {
    await page.goto('/test/annotation-style.html?elementContextMaxArea=1.5');
    await page.evaluate(() => {
      const context = document.createElement('section');
      context.id = 'centered-capture-context';
      context.style.cssText =
        'width: 400px; height: 200px; margin: 0 auto; background: rgb(239, 68, 68); display: grid; place-items: center;';

      const target = document.createElement('button');
      target.id = 'centered-capture-fixture';
      target.textContent = 'Pick';
      target.style.cssText = 'width: 40px; height: 40px;';
      context.appendChild(target);
      document.body.prepend(context);
    });

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });
    const selected = page.locator('#centered-capture-fixture');
    const selectedBox = await selected.boundingBox();
    expect(selectedBox).toBeTruthy();

    const targetX = selectedBox!.x + selectedBox!.width / 2;
    const targetY = selectedBox!.y + selectedBox!.height / 2;
    await page.mouse.move(targetX, targetY);
    await page.mouse.click(targetX, targetY);

    const canvas = host.locator('css=#annotation-canvas canvas');
    await expect(canvas).toBeVisible({ timeout: 30000 });
    const bounds = await canvas.evaluate(node => {
      const source = node as HTMLCanvasElement;
      const context = source.getContext('2d');
      if (!context) throw new Error('Missing canvas context');

      const data = context.getImageData(0, 0, source.width, source.height).data;
      const red = { minX: source.width, maxX: -1 };
      const accent = { minX: source.width, maxX: -1, minY: source.height, maxY: -1 };

      for (let y = 0; y < source.height; y++) {
        for (let x = 0; x < source.width; x++) {
          const offset = (y * source.width + x) * 4;
          const r = data[offset];
          const g = data[offset + 1];
          const b = data[offset + 2];
          const a = data[offset + 3];
          if (a > 200 && r > 220 && g < 100 && b < 100) {
            red.minX = Math.min(red.minX, x);
            red.maxX = Math.max(red.maxX, x);
          }
          if (a > 200 && r > 240 && g > 130 && g < 190 && b > 70 && b < 130) {
            accent.minX = Math.min(accent.minX, x);
            accent.maxX = Math.max(accent.maxX, x);
            accent.minY = Math.min(accent.minY, y);
            accent.maxY = Math.max(accent.maxY, y);
          }
        }
      }

      return { width: source.width, height: source.height, red, accent };
    });

    expect(bounds.width).toBe(400);
    expect(bounds.height).toBe(200);
    expect(bounds.red.minX).toBeLessThanOrEqual(2);
    expect(bounds.red.maxX).toBeGreaterThanOrEqual(bounds.width - 3);

    const expectedHighlightX = (bounds.width - selectedBox!.width) / 2;
    const expectedHighlightY = (bounds.height - selectedBox!.height) / 2;
    expect(Math.abs(bounds.accent.minX - expectedHighlightX)).toBeLessThanOrEqual(8);
    expect(
      Math.abs(bounds.accent.maxX - (expectedHighlightX + selectedBox!.width))
    ).toBeLessThanOrEqual(8);
    expect(Math.abs(bounds.accent.minY - expectedHighlightY)).toBeLessThanOrEqual(8);
    expect(
      Math.abs(bounds.accent.maxY - (expectedHighlightY + selectedBox!.height))
    ).toBeLessThanOrEqual(8);
  });

  test('element capture preserves vertical root margins while removing horizontal margins', async ({
    page,
  }) => {
    await mockHtmlToImage(page, targetSpyToPng());
    await page.goto('/test/?elementContextMaxArea=0');
    await page.evaluate(() => {
      const target = document.createElement('div');
      target.id = 'vertical-margin-capture-fixture';
      target.style.cssText = 'width: 400px; height: 200px; margin: 20px auto 30px;';
      document.body.prepend(target);
    });

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });
    const selected = page.locator('#vertical-margin-capture-fixture');
    const selectedBox = await selected.boundingBox();
    expect(selectedBox).toBeTruthy();
    await page.mouse.click(
      selectedBox!.x + selectedBox!.width / 2,
      selectedBox!.y + selectedBox!.height / 2
    );

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });
    const captureOpts = await page.evaluate(() => window.__captureOpts);
    expect(captureOpts?.style).toEqual({ margin: '20px 0px 30px 0px' });
  });

  test('element picker selects nearest clickable ancestor from nested content', async ({
    page,
  }) => {
    await mockHtmlToImage(page, targetSpyToPng());
    await page.goto('/test/?elementContextMaxArea=0');
    await page.evaluate(() => {
      const row = document.createElement('div');
      row.id = 'clickable-row-fixture';
      row.innerHTML = `
        <a id="chat-row-link" class="item-link" href="/chats/12078/">
          <div class="item-content">
            <div class="item-inner">
              <div class="item-title">
                <div class="conversation-title">
                  <div class="conversation-name">Eugene</div>
                  <div class="conversation-preview-line">test for eugene</div>
                </div>
              </div>
            </div>
          </div>
        </a>
      `;
      row.style.cssText = `
        margin: 24px;
        width: 420px;
      `;
      const link = row.querySelector<HTMLAnchorElement>('#chat-row-link');
      if (link) {
        link.style.cssText = `
          display: block;
          padding: 16px 20px;
          background: #1f2937;
          color: white;
          text-decoration: none;
        `;
      }
      document.body.prepend(row);
    });

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });

    const selected = page.locator('#clickable-row-fixture .conversation-name');
    await expect(selected).toBeVisible();
    const selectedBox = await selected.boundingBox();
    expect(selectedBox).toBeTruthy();

    await page.mouse.click(
      selectedBox!.x + selectedBox!.width / 2,
      selectedBox!.y + selectedBox!.height / 2
    );

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });

    const targetInfo = await page.evaluate(() => window.__captureTargetInfo);
    expect(targetInfo).toBeDefined();
    if (!targetInfo) throw new Error('Missing capture target info');
    expect(targetInfo.tagName).toBe('A');
    expect(targetInfo.id).toBe('chat-row-link');
    expect(targetInfo.className).toContain('item-link');
    expect(targetInfo.width).toBeGreaterThan(selectedBox!.width);
  });

  test('element picker recognizes mixed-case clickable fallback role tokens', async ({ page }) => {
    await mockHtmlToImage(page, targetSpyToPng());
    await page.goto('/test/?elementContextMaxArea=0');
    await page.evaluate(() => {
      const control = document.createElement('div');
      control.id = 'role-token-control';
      control.setAttribute('role', 'Switch Button');
      control.innerHTML = `
        <span class="role-token-label">
          <span class="role-token-name">Notifications</span>
        </span>
      `;
      control.style.cssText = `
        display: block;
        margin: 24px;
        padding: 16px 20px;
        width: 360px;
        background: #1f2937;
        color: white;
      `;
      document.body.prepend(control);
    });

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });

    const selected = page.locator('#role-token-control .role-token-name');
    await expect(selected).toBeVisible();
    const selectedBox = await selected.boundingBox();
    expect(selectedBox).toBeTruthy();

    await page.mouse.click(
      selectedBox!.x + selectedBox!.width / 2,
      selectedBox!.y + selectedBox!.height / 2
    );

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });

    const targetInfo = await page.evaluate(() => window.__captureTargetInfo);
    expect(targetInfo).toBeDefined();
    if (!targetInfo) throw new Error('Missing capture target info');
    expect(targetInfo.tagName).toBe('DIV');
    expect(targetInfo.id).toBe('role-token-control');
    expect(targetInfo.width).toBeGreaterThan(selectedBox!.width);
  });

  test('element picker uses the first recognized ARIA role token', async ({ page }) => {
    await mockHtmlToImage(page, targetSpyToPng());
    await page.goto('/test/?elementContextMaxArea=0');
    await page.evaluate(() => {
      const heading = document.createElement('div');
      heading.id = 'ordered-role-heading';
      heading.setAttribute('role', 'heading button');
      heading.innerHTML = '<span class="ordered-role-name">Notifications</span>';
      heading.style.cssText = `
        display: block;
        margin: 24px;
        padding: 16px 20px;
        width: 360px;
        background: #1f2937;
        color: white;
      `;
      document.body.prepend(heading);
    });

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });

    const selected = page.locator('#ordered-role-heading .ordered-role-name');
    await expect(selected).toBeVisible();
    const selectedBox = await selected.boundingBox();
    expect(selectedBox).toBeTruthy();

    await page.mouse.click(
      selectedBox!.x + selectedBox!.width / 2,
      selectedBox!.y + selectedBox!.height / 2
    );

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });

    const targetInfo = await page.evaluate(() => window.__captureTargetInfo);
    expect(targetInfo).toBeDefined();
    if (!targetInfo) throw new Error('Missing capture target info');
    expect(targetInfo.tagName).toBe('SPAN');
    expect(targetInfo.className).toContain('ordered-role-name');
  });

  test('element picker honors non-clickable ARIA fallback roles', async ({ page }) => {
    await mockHtmlToImage(page, targetSpyToPng());
    await page.goto('/test/?elementContextMaxArea=0');
    await page.evaluate(() => {
      const group = document.createElement('div');
      group.id = 'ordered-role-group';
      group.setAttribute('role', 'group button');
      group.innerHTML = '<span class="ordered-group-name">Messages</span>';
      group.style.cssText = `
        display: block;
        margin: 24px;
        padding: 16px 20px;
        width: 360px;
        background: #1f2937;
        color: white;
      `;
      document.body.prepend(group);
    });

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });

    const groupSelected = page.locator('#ordered-role-group .ordered-group-name');
    await expect(groupSelected).toBeVisible();
    const groupSelectedBox = await groupSelected.boundingBox();
    expect(groupSelectedBox).toBeTruthy();

    await page.mouse.click(
      groupSelectedBox!.x + groupSelectedBox!.width / 2,
      groupSelectedBox!.y + groupSelectedBox!.height / 2
    );

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });

    const groupTargetInfo = await page.evaluate(() => window.__captureTargetInfo);
    expect(groupTargetInfo).toBeDefined();
    if (!groupTargetInfo) throw new Error('Missing capture target info');
    expect(groupTargetInfo.tagName).toBe('SPAN');
    expect(groupTargetInfo.className).toContain('ordered-group-name');
  });

  test('shows error modal when capture times out', async ({ page }) => {
    await mockHtmlToImage(page, 'function() { return new Promise(function() {}); }');
    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    // The 15s timeout should fire and the error modal should appear
    const host = page.locator('#bugdrop-host');
    const errorText = host.locator('css=.bd-error-message__text');
    await expect(errorText).toBeVisible({ timeout: 20000 });
    await expect(errorText).toContainText('Failed to capture screenshot');

    // Verify the user can skip or return to the method picker.
    const skipBtn = host.locator('css=[data-action="skip"]');
    const chooseAgainBtn = host.locator('css=[data-action="choose-again"]');
    await expect(skipBtn).toBeVisible();
    await expect(chooseAgainBtn).toBeVisible();
  });

  test('closing screenshot options returns to the form without submitting', async ({ page }) => {
    const getSubmissionCount = await trackFeedbackSubmissions(page);
    await page.goto('/test/');

    const host = await navigateToScreenshotOptions(page);

    await host.locator('css=.bd-close').click();

    await expectReturnedToForm(host, 'Screenshot test');
    expect(getSubmissionCount()).toBe(0);
  });

  test('closing capture error returns to the form without submitting', async ({ page }) => {
    const getSubmissionCount = await trackFeedbackSubmissions(page);
    await mockHtmlToImage(page, "function() { return Promise.reject(new Error('mock failure')); }");
    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    const errorText = host.locator('css=.bd-error-message__text');
    await expect(errorText).toBeVisible({ timeout: 5000 });

    await host.locator('css=.bd-close').click();

    await expectReturnedToForm(host, 'Screenshot test');
    expect(getSubmissionCount()).toBe(0);
  });

  test('closing annotation step returns to the form without submitting', async ({ page }) => {
    const getSubmissionCount = await trackFeedbackSubmissions(page);
    await mockHtmlToImage(page, spyToPng());
    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    const annotationCanvas = host.locator('css=#annotation-canvas');
    await expect(annotationCanvas).toBeVisible({ timeout: 10000 });

    await host.locator('css=.bd-close').click();

    await expectReturnedToForm(host, 'Screenshot test');
    expect(getSubmissionCount()).toBe(0);
  });

  test('skip button on error modal continues without screenshot', async ({ page }) => {
    await mockHtmlToImage(page, "function() { return Promise.reject(new Error('mock failure')); }");
    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    // Wait for error modal
    const host = page.locator('#bugdrop-host');
    const errorText = host.locator('css=.bd-error-message__text');
    await expect(errorText).toBeVisible({ timeout: 5000 });

    // Click "Skip Screenshot" — should proceed to submission (no annotation step)
    const skipBtn = host.locator('css=[data-action="skip"]');
    await skipBtn.click();

    // Capture failure modal should be gone and submission should proceed.
    await expect(errorText).not.toHaveText(/Failed to capture screenshot/, { timeout: 3000 });
  });

  test('privacy masking failure shows a dedicated modal and submits without a screenshot', async ({
    page,
  }) => {
    const payloads = await trackFeedbackPayloads(page);
    // toPng resolves with a data URL that fails Image.onload, so applyMaskToImage
    // rejects with MaskApplicationError. Use /test/redaction.html so the page has
    // a [data-bugdrop-redact] element — otherwise applyMaskToImage early-returns
    // when rects.length === 0 and the failure path never fires.
    await mockHtmlToImage(
      page,
      "function() { return Promise.resolve('data:image/png;base64,not-a-real-image'); }"
    );
    await page.goto('/test/redaction.html');
    await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    const modalTitle = host.locator('css=.bd-title');
    await expect(modalTitle).toHaveText('Privacy masking failed', { timeout: 5000 });

    await expect(host.locator('css=.bd-error-message__text')).toContainText(
      'Automatic redaction of private fields could not be applied'
    );
    // Retry must NOT be offered for masking failures — retrying would fail the
    // same way and a user might be tempted to send unredacted output.
    await expect(host.locator('css=[data-action="retry"]')).not.toBeAttached();

    await host.locator('css=[data-action="skip"]').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 5000 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].screenshot).toBeNull();
  });

  test('capture failure can return to screenshot options and select another method', async ({
    page,
  }) => {
    // First call fails, second call succeeds after the user chooses a method again.
    await mockHtmlToImage(
      page,
      `function(el, opts) {
        if (!window.__retryAttempted) {
          window.__retryAttempted = true;
          return Promise.reject(new Error('first attempt fails'));
        }
        return Promise.resolve('${STUB_PNG}');
      }`
    );

    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    // Wait for error modal from first failure
    const host = page.locator('#bugdrop-host');
    const errorText = host.locator('css=.bd-error-message__text');
    await expect(errorText).toBeVisible({ timeout: 5000 });

    await host.locator('css=[data-action="choose-again"]').click();
    await expect(host.locator('css=[data-action="capture"]')).toBeVisible({ timeout: 5000 });
    await host.locator('css=[data-action="capture"]').click();

    const annotationCanvas = host.locator('css=#annotation-canvas');
    await expect(annotationCanvas).toBeVisible({ timeout: 10000 });
  });

  // --- Full-page disable threshold (10k+ nodes) ---

  test('hides Full Page and Select Area buttons on very complex pages without native viewport capture', async ({
    page,
  }) => {
    await mockHtmlToImage(page, spyToPng());
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {},
        configurable: true,
      });
    });
    await page.goto('/test/redaction.html');
    await page.evaluate(() => {
      const root = document.createElement('div');
      root.id = 'complexity-padding';
      for (let i = 0; i < 12000; i++) {
        const node = document.createElement('span');
        node.textContent = `Item ${i}`;
        root.appendChild(node);
      }
      document.body.appendChild(root);
    });

    const nodeCount = await page.evaluate(() => document.body.querySelectorAll('*').length);
    expect(nodeCount).toBeGreaterThanOrEqual(10000);

    const host = await navigateToScreenshotOptions(page);

    // Select Element should still be visible
    await expect(host.locator('css=[data-action="element"]')).toBeVisible();

    // Full Page and Select Area should be hidden
    await expect(host.locator('css=[data-action="capture"]')).not.toBeAttached();
    await expect(host.locator('css=[data-action="area"]')).not.toBeAttached();

    // Complexity notice should be shown
    const notice = host.locator('css=p >> text=too complex');
    await expect(notice).toBeVisible();
  });

  test('hides full-page and area capture earlier for complex Safari pages', async ({ page }) => {
    await mockHtmlToImage(
      page,
      "function() { throw new Error('html-to-image should not run for Safari complex-page options'); }"
    );
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {},
        configurable: true,
      });
      Object.defineProperty(navigator, 'userAgent', {
        get: () =>
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/616.1.16 (KHTML, like Gecko) Version/26.4 Safari/616.1.16',
        configurable: true,
      });
    });
    await page.goto('/test/complex-dom.html?nodes=4000');

    const nodeCount = await page.evaluate(() => document.body.querySelectorAll('*').length);
    expect(nodeCount).toBeGreaterThanOrEqual(3000);
    expect(nodeCount).toBeLessThan(10000);

    const host = await navigateToScreenshotOptions(page);

    await expect(host.locator('css=[data-action="element"]')).toBeVisible();
    await expect(host.locator('css=[data-action="capture"]')).not.toBeAttached();
    await expect(host.locator('css=[data-action="area"]')).not.toBeAttached();
    await expect(host.locator('css=p >> text=too complex')).toBeVisible();
  });

  test('offers native viewport capture on very complex secure-context pages', async ({ page }) => {
    const payloads = await trackFeedbackPayloads(page);
    await mockHtmlToImage(
      page,
      "function() { throw new Error('html-to-image should not run for viewport capture'); }"
    );
    await mockGetDisplayMedia(
      page,
      `function(opts) {
        window.__viewportCaptureCalls = (window.__viewportCaptureCalls || 0) + 1;
        window.__viewportCaptureUserActivation = navigator.userActivation.isActive;
        window.__viewportCaptureOpts = opts;
        var canvas = document.createElement('canvas');
        canvas.width = 960;
        canvas.height = 540;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#101827';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#22d3ee';
        ctx.fillRect(40, 40, 880, 120);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 42px sans-serif';
        ctx.fillText('Native viewport capture', 80, 115);
        var stream = canvas.captureStream();
        var track = stream.getVideoTracks()[0];
        var originalStop = track.stop.bind(track);
        track.getSettings = function() { return { displaySurface: 'browser' }; };
        track.stop = function() {
          window.__viewportTrackStops = (window.__viewportTrackStops || 0) + 1;
          originalStop();
        };
        return Promise.resolve(stream);
      }`
    );
    await page.goto('/test/complex-dom.html?nodes=12000');

    const nodeCount = await page.evaluate(() => document.body.querySelectorAll('*').length);
    expect(nodeCount).toBeGreaterThanOrEqual(10000);

    const host = await navigateToScreenshotOptions(page);

    const viewportBtn = host.locator('css=[data-action="viewport"]');
    await expect(viewportBtn).toBeVisible();
    await expect(viewportBtn).toHaveText('Screenshot Issues? Capture Viewport instead');
    await expect(host.locator('css=[data-action="capture"]')).not.toBeAttached();
    await expect(host.locator('css=[data-action="area"]')).not.toBeAttached();
    await expect(host.locator('css=p >> text=visible viewport')).toBeVisible();
    await expect(host.locator('css=.bd-redaction-note')).not.toBeAttached();

    await viewportBtn.click();

    await expect(host.locator('css=.bd-modal--annotator')).toBeVisible({ timeout: 10000 });
    await expect(host.locator('css=#annotation-canvas canvas')).toBeVisible();
    await expect(host.locator('css=.bd-redaction-note')).toContainText(
      'could not apply automatic private-field masks'
    );
    await expect(host.locator('css=.bd-redaction-note')).not.toContainText(
      'private item was marked for redaction'
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __viewportCaptureCalls?: number }).__viewportCaptureCalls || 0
        )
      )
      .toBe(1);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __viewportTrackStops?: number }).__viewportTrackStops || 0
        )
      )
      .toBe(1);
    const viewportCapture = await page.evaluate(() => {
      const win = window as Window & {
        __viewportCaptureOpts?: DisplayMediaStreamOptions & { preferCurrentTab?: boolean };
        __viewportCaptureUserActivation?: boolean;
      };
      return {
        opts: win.__viewportCaptureOpts,
        userActivation: win.__viewportCaptureUserActivation,
      };
    });
    expect(viewportCapture.userActivation).toBe(true);
    expect(viewportCapture.opts).toEqual({
      video: { displaySurface: 'browser' },
      audio: false,
      preferCurrentTab: true,
    });
    const captureOpts = await page.evaluate(
      () => (window as Window & { __captureOpts?: unknown }).__captureOpts
    );
    expect(captureOpts).toBeUndefined();

    await host.locator('css=[data-action="done"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].screenshot).toEqual(expect.stringMatching(/^data:image\/png;base64,/));
  });

  test('returns to screenshot options after native viewport capture fails', async ({ page }) => {
    await mockGetDisplayMedia(
      page,
      `function() {
        window.__viewportCaptureCalls = (window.__viewportCaptureCalls || 0) + 1;
        if (window.__viewportCaptureCalls === 1) {
          return Promise.reject(new Error('Permission denied'));
        }
        var canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        canvas.getContext('2d').fillRect(0, 0, 2, 2);
        var stream = canvas.captureStream();
        stream.getVideoTracks()[0].getSettings = function() { return { displaySurface: 'browser' }; };
        return Promise.resolve(stream);
      }`
    );
    await page.goto('/test/complex-dom.html?nodes=12000');

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="viewport"]').click();

    const errorText = host.locator('css=.bd-error-message__text');
    await expect(errorText).toBeVisible({ timeout: 5000 });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __viewportCaptureCalls?: number }).__viewportCaptureCalls || 0
        )
      )
      .toBe(1);

    await host.locator('css=[data-action="choose-again"]').click();
    await expect(host.locator('css=[data-action="viewport"]')).toBeVisible({ timeout: 5000 });
    await host.locator('css=[data-action="viewport"]').click();

    await expect(host.locator('css=.bd-modal--annotator')).toBeVisible({ timeout: 10000 });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __viewportCaptureCalls?: number }).__viewportCaptureCalls || 0
        )
      )
      .toBe(2);
  });

  test('rejects non-browser native capture surfaces before annotation', async ({ page }) => {
    await mockGetDisplayMedia(
      page,
      `function() {
        var canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        var stream = canvas.captureStream();
        var track = stream.getVideoTracks()[0];
        var originalStop = track.stop.bind(track);
        track.getSettings = function() { return { displaySurface: 'monitor' }; };
        track.stop = function() {
          window.__viewportTrackStops = (window.__viewportTrackStops || 0) + 1;
          originalStop();
        };
        return Promise.resolve(stream);
      }`
    );
    await page.goto('/test/complex-dom.html?nodes=12000');

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="viewport"]').click();

    await expect(host.locator('css=.bd-error-message__text')).toBeVisible({ timeout: 5000 });
    await expect(host.locator('css=.bd-modal--annotator')).not.toBeAttached();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __viewportTrackStops?: number }).__viewportTrackStops || 0
        )
      )
      .toBe(1);
  });

  test('remembers complex-page screenshot skip for issue #116 repeated reports', async ({
    page,
  }) => {
    const payloads = await trackFeedbackPayloads(page);
    await page.goto('/test/complex-dom.html?nodes=12000');

    const nodeCount = await page.evaluate(() => document.body.querySelectorAll('*').length);
    expect(nodeCount).toBeGreaterThanOrEqual(10000);

    const host = await navigateToScreenshotOptions(page);
    await expect(host.locator('css=p >> text=too complex')).toBeVisible();

    await host.locator('css=[data-action="skip"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 5000 });
    expect(payloads).toHaveLength(1);

    await host.locator('css=.bd-close').click();
    await host.locator('css=.bd-trigger').click();

    const secondTitle = host.locator('css=#title');
    await expect(secondTitle).toBeVisible({ timeout: 5000 });
    await secondTitle.fill('Issue 116 second report');

    const screenshotCheckbox = host.locator('css=#include-screenshot');
    await expect(screenshotCheckbox).not.toBeChecked();

    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=[data-action="element"]')).not.toBeVisible();
    await expect(host.locator('css=p >> text=too complex')).not.toBeVisible();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 5000 });
    expect(payloads).toHaveLength(2);

    for (const payload of payloads) {
      const metadata = payload.metadata as { domNodeCount?: number; fullPageDisabled?: boolean };
      expect(payload.screenshot).toBeNull();
      expect(metadata.domNodeCount).toBeGreaterThanOrEqual(10000);
      expect(metadata.fullPageDisabled).toBe(true);
    }
  });

  test('persists complex-page screenshot skip after reload for issue #116', async ({ page }) => {
    const payloads = await trackFeedbackPayloads(page);
    await page.goto('/test/complex-dom.html?nodes=12000');

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="skip"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 5000 });

    await page.reload();
    await host.locator('css=.bd-trigger').click();

    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill('Issue 116 after reload');

    await expect(host.locator('css=#include-screenshot')).not.toBeChecked();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=[data-action="element"]')).not.toBeVisible();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 5000 });
    expect(payloads).toHaveLength(2);
    expect(payloads[1].screenshot).toBeNull();
  });

  test('complex-page screenshot skip is scoped to redacted page and current complexity', async ({
    page,
  }) => {
    await trackFeedbackSubmissions(page);
    await page.goto('/test/complex-dom.html?nodes=12000');

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="skip"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 5000 });

    await page.goto('/test/complex-dom.html?nodes=4000');
    await host.locator('css=.bd-trigger').click();
    await expect(host.locator('css=#title')).toBeVisible({ timeout: 5000 });
    await expect(host.locator('css=#include-screenshot')).toBeChecked();
    await host.locator('css=.bd-close').click();

    await page.goto('/test/complex-dom.html?nodes=12001');
    await host.locator('css=.bd-trigger').click();
    await expect(host.locator('css=#title')).toBeVisible({ timeout: 5000 });
    await expect(host.locator('css=#include-screenshot')).not.toBeChecked();
  });

  test('complex-page screenshot skip is scoped by repo', async ({ page }) => {
    await trackFeedbackSubmissions(page);
    await page.goto('/test/complex-dom.html?nodes=12000&repo=owner/repo-a');

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="skip"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 5000 });

    await page.goto('/test/complex-dom.html?nodes=12000&repo=owner/repo-b');
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await expect(host.locator('css=#title')).toBeVisible({ timeout: 5000 });
    await expect(host.locator('css=#include-screenshot')).toBeChecked();
  });

  test('complex-page screenshot skip does not apply after same-url DOM becomes simple', async ({
    page,
  }) => {
    await trackFeedbackSubmissions(page);
    await page.goto('/test/complex-dom.html?nodes=12000');

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="skip"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 5000 });
    await host.locator('css=.bd-close').click();

    await page.evaluate(() => {
      document.querySelector('#complex-root')?.replaceChildren();
    });

    await host.locator('css=.bd-trigger').click();
    await expect(host.locator('css=#title')).toBeVisible({ timeout: 5000 });
    await expect(host.locator('css=#include-screenshot')).toBeChecked();
  });

  test('allows users to opt back into screenshots after complex-page skip', async ({ page }) => {
    await trackFeedbackSubmissions(page);
    await page.goto('/test/complex-dom.html?nodes=12000');

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="skip"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 5000 });

    await host.locator('css=.bd-close').click();
    await host.locator('css=.bd-trigger').click();

    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill('Issue 116 opt back in');
    const screenshotCheckbox = host.locator('css=#include-screenshot');
    await expect(screenshotCheckbox).not.toBeChecked();
    await screenshotCheckbox.check();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=p >> text=too complex')).toBeVisible();
    await expect(host.locator('css=[data-action="element"]')).toBeVisible();
  });

  test('remembers complex-page skip after element capture failure skip', async ({ page }) => {
    const payloads = await trackFeedbackPayloads(page);
    await mockHtmlToImage(page, "function() { return Promise.reject(new Error('mock failure')); }");
    await page.goto('/test/complex-dom.html?nodes=12000');

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });

    const heading = page.locator('h1');
    const headingBox = await heading.boundingBox();
    expect(headingBox).toBeTruthy();
    await page.mouse.click(
      headingBox!.x + headingBox!.width / 2,
      headingBox!.y + headingBox!.height / 2
    );

    await expect(host.locator('css=.bd-error-message__text')).toBeVisible({ timeout: 5000 });
    await host.locator('css=[data-action="skip"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 5000 });
    expect(payloads).toHaveLength(1);
    const metadata = payloads[0].metadata as {
      elementSelector?: string;
      fullElementSelector?: string;
      selectedElementHighlightColor?: string;
    };
    expect(metadata.elementSelector).toContain('h1');
    expect(metadata.selectedElementHighlightColor).toBe(DEFAULT_ACCENT_COLOR);
    expect(metadata.fullElementSelector).toContain('html > body');
    expect(metadata.fullElementSelector).toContain('h1');
    expect(
      await page.evaluate(selector => {
        return document.querySelector(selector) === document.querySelector('h1');
      }, metadata.fullElementSelector)
    ).toBe(true);

    await host.locator('css=.bd-close').click();
    await host.locator('css=.bd-trigger').click();
    await expect(host.locator('css=#title')).toBeVisible({ timeout: 5000 });
    await expect(host.locator('css=#include-screenshot')).not.toBeChecked();
  });

  test('does not remember complex-page skip after element picker cancellation', async ({
    page,
  }) => {
    const payloads = await trackFeedbackPayloads(page);
    await page.goto('/test/complex-dom.html?nodes=12000');

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="element"]').click();
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 5000 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].screenshot).toBeNull();
    const metadata = payloads[0].metadata as {
      elementSelector?: string | null;
      fullElementSelector?: string | null;
    };
    expect(metadata.elementSelector).toBeNull();
    expect(metadata.fullElementSelector).toBeNull();

    await host.locator('css=.bd-close').click();
    await host.locator('css=.bd-trigger').click();
    await expect(host.locator('css=#title')).toBeVisible({ timeout: 5000 });
    await expect(host.locator('css=#include-screenshot')).toBeChecked();
  });

  test('shows all buttons on pages below 10k nodes', async ({ page }) => {
    await mockHtmlToImage(page, spyToPng());
    await page.goto('/test/complex-dom.html?nodes=4000');

    const nodeCount = await page.evaluate(() => document.body.querySelectorAll('*').length);
    expect(nodeCount).toBeLessThan(10000);

    const host = await navigateToScreenshotOptions(page);

    await expect(host.locator('css=[data-action="element"]')).toBeVisible();
    await expect(host.locator('css=[data-action="capture"]')).toBeVisible();
    await expect(host.locator('css=[data-action="area"]')).toBeVisible();

    // Complexity notice should NOT be shown
    await expect(host.locator('css=p >> text=too complex')).not.toBeAttached();
  });

  test('communicates developer redactions for full-page screenshots', async ({ page }) => {
    await mockHtmlToImage(page, redactionAwarePng());
    await page.goto('/test/redaction.html');

    const host = await navigateToScreenshotOptions(page);
    await expect(host.locator('css=.bd-redaction-note')).toContainText(
      'marked some fields for redaction'
    );

    await host.locator('css=[data-action="capture"]').click();

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });
    await expect(host.locator('css=.bd-redaction-note')).toContainText(
      '1 private item was marked for redaction'
    );
    await expect(page.locator('#redacted-test-input')).toHaveValue('sk_live_local_test_secret');
  });

  test('communicates developer redactions for selected-area screenshots', async ({ page }) => {
    await mockHtmlToImage(page, redactionAwarePng());
    await page.goto('/test/redaction.html');
    await page.locator('#redacted-test-input').scrollIntoViewIfNeeded();

    const host = await navigateToScreenshotOptions(page);
    await host.locator('css=[data-action="area"]').click();
    await expect(page.locator('#bugdrop-area-picker-overlay')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#bugdrop-area-picker-tooltip')).toContainText(
      'Marked private fields may be masked if included'
    );

    const box = await page.locator('#redacted-test-input').boundingBox();
    expect(box).toBeTruthy();

    await page.mouse.move(box!.x - 8, box!.y - 8);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width + 8, box!.y + box!.height + 8);
    await page.mouse.up();

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });
    await expect(host.locator('css=.bd-redaction-note')).toContainText(
      '1 private item was marked for redaction'
    );

    const captureOpts = await page.evaluate(
      () =>
        (window as Window & { __captureOpts?: { width?: number; height?: number } }).__captureOpts
    );
    expect(captureOpts?.width).toBeGreaterThan(100);
    expect(captureOpts?.height).toBeGreaterThan(40);
    await expect(page.locator('#redacted-test-input')).toHaveValue('sk_live_local_test_secret');
  });

  test('annotation modal gives issue #117 style previews enough readable width', async ({
    page,
  }) => {
    await mockHtmlToImage(page, reporterLikePng('preview-size'));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    const modal = host.locator('css=.bd-modal--annotator');
    const stage = host.locator('css=#annotation-canvas');
    const canvas = stage.locator('css=canvas');

    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(stage).toBeVisible();
    await expect(canvas).toBeVisible();
    await modal.evaluate(async el => {
      await Promise.all(el.getAnimations().map(animation => animation.finished));
    });

    const modalBox = await modal.boundingBox();
    const stageBox = await stage.boundingBox();
    const canvasBox = await canvas.boundingBox();

    expect(modalBox?.width).toBeGreaterThanOrEqual(1040);
    expect(stageBox?.width).toBeGreaterThanOrEqual(980);
    expect(canvasBox?.width).toBeGreaterThanOrEqual(980);

    const toolbarBox = await host.locator('css=.bd-tools').boundingBox();
    const actionsBox = await host.locator('css=.bd-actions').boundingBox();
    expect(toolbarBox && stageBox ? toolbarBox.y + toolbarBox.height <= stageBox.y : false).toBe(
      true
    );
    expect(stageBox && actionsBox ? stageBox.y + stageBox.height <= actionsBox.y : false).toBe(
      true
    );
  });

  test('annotation stage frames issue #119 style short wide captures clearly', async ({ page }) => {
    await mockHtmlToImage(page, reporterLikePng('small-wide-area'));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    const stage = host.locator('css=#annotation-canvas');
    const canvas = stage.locator('css=canvas');

    await expect(host.locator('css=.bd-modal--annotator')).toBeVisible({ timeout: 10000 });
    await expect(stage).toBeVisible();
    await expect(canvas).toBeVisible();

    const stageBox = await stage.boundingBox();
    const canvasBox = await canvas.boundingBox();
    expect(stageBox?.width).toBeGreaterThanOrEqual(980);
    expect(stageBox?.height).toBeGreaterThanOrEqual(230);
    expect(canvasBox?.width).toBeLessThan(320);
    expect(canvasBox?.height).toBeLessThan(90);

    const stageStyles = await stage.evaluate(el => {
      const styles = getComputedStyle(el);
      return {
        borderStyle: styles.borderTopStyle,
        borderWidth: styles.borderTopWidth,
        overflow: styles.overflow,
        padding: styles.paddingTop,
      };
    });

    expect(stageStyles.borderStyle).not.toBe('none');
    expect(parseFloat(stageStyles.borderWidth)).toBeGreaterThan(0);
    expect(stageStyles.overflow).toBe('auto');
    expect(parseFloat(stageStyles.padding)).toBeGreaterThan(0);

    expect(stageBox && canvasBox ? canvasBox.x > stageBox.x : false).toBe(true);
    expect(stageBox && canvasBox ? canvasBox.y > stageBox.y : false).toBe(true);
  });

  test('real element capture keeps issue #117 style content readable in annotation preview', async ({
    page,
  }) => {
    const { modal, stage, canvas } = await captureElementForAnnotation(
      page,
      '/test/annotation-preview-size.html',
      '#preview-size-target'
    );
    await modal.evaluate(async el => {
      await Promise.all(el.getAnimations().map(animation => animation.finished));
    });

    const modalBox = await modal.boundingBox();
    const stageBox = await stage.boundingBox();
    const canvasBox = await canvas.boundingBox();
    const intrinsicSize = await canvas.evaluate(el => ({
      width: (el as HTMLCanvasElement).width,
      height: (el as HTMLCanvasElement).height,
    }));

    expect(intrinsicSize.width).toBeGreaterThanOrEqual(1000);
    expect(intrinsicSize.height).toBeGreaterThanOrEqual(250);
    expect(modalBox?.width).toBeGreaterThanOrEqual(1040);
    expect(stageBox?.width).toBeGreaterThanOrEqual(980);
    expect(canvasBox?.width).toBeGreaterThanOrEqual(980);
  });

  test('real element capture clearly frames issue #119 style small annotation targets', async ({
    page,
  }) => {
    const { stage, canvas } = await captureElementForAnnotation(
      page,
      '/test/annotation-small-wide-area.html',
      '#small-wide-target'
    );

    const stageBox = await stage.boundingBox();
    const canvasBox = await canvas.boundingBox();
    const intrinsicSize = await canvas.evaluate(el => ({
      width: (el as HTMLCanvasElement).width,
      height: (el as HTMLCanvasElement).height,
    }));

    expect(intrinsicSize.width).toBeLessThanOrEqual(600);
    expect(intrinsicSize.height).toBeLessThanOrEqual(140);
    expect(stageBox?.width).toBeGreaterThanOrEqual(980);
    expect(stageBox?.height).toBeGreaterThanOrEqual(230);
    expect(canvasBox?.width).toBeLessThan(600);
    expect(canvasBox?.height).toBeLessThan(140);

    const frame = await stage.evaluate(el => {
      const styles = getComputedStyle(el);
      return {
        borderWidth: parseFloat(styles.borderTopWidth),
        padding: parseFloat(styles.paddingTop),
        overflow: styles.overflow,
      };
    });

    expect(frame.borderWidth).toBeGreaterThan(0);
    expect(frame.padding).toBeGreaterThan(0);
    expect(frame.overflow).toBe('auto');
    expect(stageBox && canvasBox ? canvasBox.x > stageBox.x : false).toBe(true);
    expect(stageBox && canvasBox ? canvasBox.y > stageBox.y : false).toBe(true);
  });

  test('annotation tools use high-contrast red styling for issue #115', async ({ page }) => {
    await mockHtmlToImage(page, reporterLikePng('annotation-style'));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/test/annotation-style.html');
    await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    const stage = host.locator('css=#annotation-canvas');
    const canvas = stage.locator('css=canvas');
    await expect(host.locator('css=.bd-modal--annotator')).toBeVisible({ timeout: 10000 });
    await expect(stage).toBeVisible();
    await expect(canvas).toBeVisible();

    const before = await countAnnotationPixels(canvas);

    await host.locator('css=[data-tool="arrow"]').click();
    await dragOnCanvas(page, canvas, { x: 0.72, y: 0.17 }, { x: 0.28, y: 0.34 });

    await host.locator('css=[data-tool="rect"]').click();
    await dragOnCanvas(page, canvas, { x: 0.58, y: 0.36 }, { x: 0.82, y: 0.72 });

    const after = await countAnnotationPixels(canvas);

    expect(after.red - before.red).toBeGreaterThan(2500);
    expect(after.orange - before.orange).toBeLessThan(100);

    const stageBox = await stage.boundingBox();
    const canvasBox = await canvas.boundingBox();
    expect(stageBox?.width).toBeGreaterThanOrEqual(980);
    expect(canvasBox?.width).toBeGreaterThan(600);

    await page.screenshot({
      path: test.info().outputPath('issue-115-annotation-style.png'),
      fullPage: false,
    });
  });

  for (const tool of ['draw', 'arrow', 'rect'] as const) {
    test(`undo button removes the latest ${tool} annotation for issue #128`, async ({ page }) => {
      await mockHtmlToImage(page, reporterLikePng('undo'));
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto('/test/');
      await navigateToFullPageCapture(page);

      const host = page.locator('#bugdrop-host');
      const stage = host.locator('css=#annotation-canvas');
      const canvas = stage.locator('css=canvas');
      await expect(host.locator('css=.bd-modal--annotator')).toBeVisible({ timeout: 10000 });
      await expect(stage).toBeVisible();
      await expect(canvas).toBeVisible();
      await expect.poll(() => canvas.evaluate(el => (el as HTMLCanvasElement).width)).toBe(600);

      await host.locator(`css=[data-tool="${tool}"]`).click();
      await dragOnCanvas(page, canvas, { x: 0.18, y: 0.28 }, { x: 0.42, y: 0.68 });
      await dragOnCanvas(page, canvas, { x: 0.58, y: 0.28 }, { x: 0.82, y: 0.68 });

      const firstRegion = { left: 0.1, top: 0.18, right: 0.48, bottom: 0.78 };
      const latestRegion = { left: 0.52, top: 0.18, right: 0.9, bottom: 0.78 };
      const firstBeforeUndo = await countRedPixelsInRegion(canvas, firstRegion);
      const latestBeforeUndo = await countRedPixelsInRegion(canvas, latestRegion);

      expect(firstBeforeUndo).toBeGreaterThan(20);
      expect(latestBeforeUndo).toBeGreaterThan(20);

      await host.locator('css=[data-action="undo"]').click();

      const firstAfterOneUndo = await countRedPixelsInRegion(canvas, firstRegion);
      const latestAfterOneUndo = await countRedPixelsInRegion(canvas, latestRegion);

      expect(firstAfterOneUndo).toBeGreaterThan(20);
      expect(latestAfterOneUndo).toBeLessThan(5);

      await host.locator('css=[data-action="undo"]').click();

      const firstAfterTwoUndos = await countRedPixelsInRegion(canvas, firstRegion);
      const latestAfterTwoUndos = await countRedPixelsInRegion(canvas, latestRegion);

      expect(firstAfterTwoUndos).toBeLessThan(5);
      expect(latestAfterTwoUndos).toBeLessThan(5);

      await host.locator('css=[data-action="undo"]').click();

      expect(await countRedPixelsInRegion(canvas, firstRegion)).toBeLessThan(5);
      expect(await countRedPixelsInRegion(canvas, latestRegion)).toBeLessThan(5);
    });
  }

  test('redact tool bakes black regions into the submitted screenshot', async ({ page }) => {
    const payloads = await trackFeedbackPayloads(page);
    await mockHtmlToImage(page, reporterLikePng('undo'));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    const canvas = host.locator('css=#annotation-canvas canvas');
    await expect(host.locator('css=.bd-modal--annotator')).toBeVisible({ timeout: 10000 });
    await expect(canvas).toBeVisible();
    await expect.poll(() => canvas.evaluate(el => (el as HTMLCanvasElement).width)).toBe(600);
    await expect(host.locator('css=[data-tool="redact"]')).toBeVisible();

    const annotationRegion = { left: 0.08, top: 0.18, right: 0.32, bottom: 0.78 };
    const redactionRegion = { left: 0.52, top: 0.18, right: 0.9, bottom: 0.78 };
    const baselineBlackPixels = await countBlackPixelsInRegion(canvas, redactionRegion);

    await host.locator('css=[data-tool="draw"]').click();
    await dragOnCanvas(page, canvas, { x: 0.14, y: 0.28 }, { x: 0.3, y: 0.68 });

    await host.locator('css=[data-tool="redact"]').click();
    await dragOnCanvas(page, canvas, { x: 0.82, y: 0.68 }, { x: 0.58, y: 0.28 });

    expect(await countRedPixelsInRegion(canvas, annotationRegion)).toBeGreaterThan(20);
    expect(await countBlackPixelsInRegion(canvas, redactionRegion)).toBeGreaterThan(
      baselineBlackPixels + 1000
    );

    await host.locator('css=[data-action="done"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

    expect(payloads).toHaveLength(1);
    const submittedScreenshot = payloads[0].screenshot;
    expect(typeof submittedScreenshot).toBe('string');

    expect(
      await countRedPixelsInDataUrl(page, submittedScreenshot as string, annotationRegion)
    ).toBeGreaterThan(20);
    expect(
      await countBlackPixelsInDataUrl(page, submittedScreenshot as string, redactionRegion)
    ).toBeGreaterThan(baselineBlackPixels + 1000);
  });

  test('undo button removes the latest redaction without removing earlier redactions', async ({
    page,
  }) => {
    const payloads = await trackFeedbackPayloads(page);
    await mockHtmlToImage(page, reporterLikePng('undo'));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    const canvas = host.locator('css=#annotation-canvas canvas');
    await expect(host.locator('css=.bd-modal--annotator')).toBeVisible({ timeout: 10000 });
    await expect(canvas).toBeVisible();
    await expect.poll(() => canvas.evaluate(el => (el as HTMLCanvasElement).width)).toBe(600);

    await host.locator('css=[data-tool="redact"]').click();
    await dragOnCanvas(page, canvas, { x: 0.18, y: 0.28 }, { x: 0.42, y: 0.68 });
    await dragOnCanvas(page, canvas, { x: 0.58, y: 0.28 }, { x: 0.82, y: 0.68 });

    const firstRegion = { left: 0.1, top: 0.18, right: 0.48, bottom: 0.78 };
    const latestRegion = { left: 0.52, top: 0.18, right: 0.9, bottom: 0.78 };

    expect(await countBlackPixelsInRegion(canvas, firstRegion)).toBeGreaterThan(1000);
    expect(await countBlackPixelsInRegion(canvas, latestRegion)).toBeGreaterThan(1000);

    await host.locator('css=[data-action="undo"]').click();

    expect(await countBlackPixelsInRegion(canvas, firstRegion)).toBeGreaterThan(1000);
    expect(await countBlackPixelsInRegion(canvas, latestRegion)).toBeLessThan(20);

    await host.locator('css=[data-action="done"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

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

  test('undo preserves mixed annotation history in the submitted screenshot for issue #128', async ({
    page,
  }) => {
    const payloads = await trackFeedbackPayloads(page);
    await mockHtmlToImage(page, reporterLikePng('undo'));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    const stage = host.locator('css=#annotation-canvas');
    const canvas = stage.locator('css=canvas');
    await expect(host.locator('css=.bd-modal--annotator')).toBeVisible({ timeout: 10000 });
    await expect(stage).toBeVisible();
    await expect(canvas).toBeVisible();

    const drawRegion = { left: 0.08, top: 0.18, right: 0.32, bottom: 0.78 };
    const arrowRegion = { left: 0.36, top: 0.18, right: 0.6, bottom: 0.78 };
    const undoneRectRegion = { left: 0.62, top: 0.18, right: 0.9, bottom: 0.5 };
    const finalRectRegion = { left: 0.62, top: 0.52, right: 0.9, bottom: 0.9 };

    await host.locator('css=[data-tool="draw"]').click();
    await dragOnCanvas(page, canvas, { x: 0.14, y: 0.28 }, { x: 0.3, y: 0.68 });

    await host.locator('css=[data-tool="arrow"]').click();
    await dragOnCanvas(page, canvas, { x: 0.4, y: 0.28 }, { x: 0.58, y: 0.68 });

    await host.locator('css=[data-tool="rect"]').click();
    await dragOnCanvas(page, canvas, { x: 0.66, y: 0.22 }, { x: 0.86, y: 0.45 });

    expect(await countRedPixelsInRegion(canvas, drawRegion)).toBeGreaterThan(20);
    expect(await countRedPixelsInRegion(canvas, arrowRegion)).toBeGreaterThan(20);
    expect(await countRedPixelsInRegion(canvas, undoneRectRegion)).toBeGreaterThan(20);

    await host.locator('css=[data-action="undo"]').click();

    expect(await countRedPixelsInRegion(canvas, drawRegion)).toBeGreaterThan(20);
    expect(await countRedPixelsInRegion(canvas, arrowRegion)).toBeGreaterThan(20);
    expect(await countRedPixelsInRegion(canvas, undoneRectRegion)).toBeLessThan(5);

    await dragOnCanvas(page, canvas, { x: 0.66, y: 0.58 }, { x: 0.86, y: 0.84 });
    expect(await countRedPixelsInRegion(canvas, finalRectRegion)).toBeGreaterThan(20);

    await host.locator('css=[data-action="done"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

    expect(payloads).toHaveLength(1);
    const submittedScreenshot = payloads[0].screenshot;
    expect(typeof submittedScreenshot).toBe('string');

    expect(
      await countRedPixelsInDataUrl(page, submittedScreenshot as string, drawRegion)
    ).toBeGreaterThan(20);
    expect(
      await countRedPixelsInDataUrl(page, submittedScreenshot as string, arrowRegion)
    ).toBeGreaterThan(20);
    expect(
      await countRedPixelsInDataUrl(page, submittedScreenshot as string, undoneRectRegion)
    ).toBeLessThan(5);
    expect(
      await countRedPixelsInDataUrl(page, submittedScreenshot as string, finalRectRegion)
    ).toBeGreaterThan(20);
  });

  test('undo cancels an unfinished annotation draft for issue #128', async ({ page }) => {
    await mockHtmlToImage(page, reporterLikePng('undo'));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/test/');
    await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    const canvas = host.locator('css=#annotation-canvas canvas');
    await expect(host.locator('css=.bd-modal--annotator')).toBeVisible({ timeout: 10000 });
    await expect(canvas).toBeVisible();

    const committedRegion = { left: 0.08, top: 0.18, right: 0.32, bottom: 0.78 };
    const draftRegion = { left: 0.52, top: 0.18, right: 0.9, bottom: 0.78 };

    await dragOnCanvas(page, canvas, { x: 0.14, y: 0.28 }, { x: 0.3, y: 0.68 });
    expect(await countRedPixelsInRegion(canvas, committedRegion)).toBeGreaterThan(20);

    await host.locator('css=[data-tool="arrow"]').click();
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.28);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.82, box!.y + box!.height * 0.68, {
      steps: 12,
    });
    expect(await countRedPixelsInRegion(canvas, draftRegion)).toBeGreaterThan(20);

    await host.locator('css=[data-action="undo"]').dispatchEvent('click');
    await page.mouse.up();

    expect(await countRedPixelsInRegion(canvas, committedRegion)).toBeGreaterThan(20);
    expect(await countRedPixelsInRegion(canvas, draftRegion)).toBeLessThan(5);
  });

  // --- Metadata: domNodeCount and fullPageDisabled in submission payload ---

  // Helper: submit feedback without screenshot, capturing the POST body
  async function submitAndCaptureMetadata(page: Page) {
    let capturedMetadata: Record<string, unknown> | null = null;

    await page.route('**/feedback', async route => {
      const body = route.request().postDataJSON();
      capturedMetadata = body.metadata;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });

    const host = await navigateToForm(page, 'Metadata test');

    // Uncheck screenshot and submit
    const screenshotCheckbox = host.locator('css=#include-screenshot');
    await screenshotCheckbox.uncheck();

    const submitBtn = host.locator('css=#submit-btn');
    await submitBtn.click();

    // Wait for success modal (confirms submission completed)
    const successModal = host.locator('css=.bd-success-icon');
    await expect(successModal).toBeVisible({ timeout: 10000 });

    return capturedMetadata!;
  }

  test('includes domNodeCount and fullPageDisabled=false in metadata on simple pages', async ({
    page,
  }) => {
    await page.goto('/test/');

    const metadata = await submitAndCaptureMetadata(page);

    expect(metadata).toBeTruthy();
    expect(typeof metadata.domNodeCount).toBe('number');
    expect(metadata.domNodeCount).toBeGreaterThan(0);
    expect(metadata.domNodeCount).toBeLessThan(10000);
    expect(metadata.fullPageDisabled).toBe(false);
  });

  test('includes domNodeCount and fullPageDisabled=true in metadata on complex pages', async ({
    page,
  }) => {
    await page.goto('/test/complex-dom.html?nodes=12000');

    const metadata = await submitAndCaptureMetadata(page);

    expect(metadata).toBeTruthy();
    expect(typeof metadata.domNodeCount).toBe('number');
    expect(metadata.domNodeCount).toBeGreaterThanOrEqual(10000);
    expect(metadata.fullPageDisabled).toBe(true);
  });

  // --- Real capture (no mock) — verifies bundled html-to-image works ---

  test('real bundled html-to-image captures a screenshot without mocks', async ({ page }) => {
    await page.goto('/test/');

    // No __bugdropMockToPng — real html-to-image runs here
    await navigateToFullPageCapture(page);

    const annotationCanvas = page.locator('#bugdrop-host').locator('css=#annotation-canvas');
    await expect(annotationCanvas).toBeVisible({ timeout: 30000 });
  });

  test('real full-page capture tolerates third-party images without CORS headers', async ({
    page,
  }) => {
    await page.goto('/test/');
    await addCorsBlockedImage(page);

    await navigateToFullPageCapture(page);

    const host = page.locator('#bugdrop-host');
    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });
    await expect(host.locator('css=.bd-error-message__text')).not.toBeAttached();
  });
});

test.describe('Screenshot Mode Configuration', () => {
  const STUB_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  async function setupInstalledApp(page: Page) {
    await page.route('**/api/check**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      });
    });
  }

  async function setupSuccessfulSubmit(page: Page) {
    let payload: Record<string, unknown> | null = null;
    await page.route('**/feedback', async route => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });
    return () => payload;
  }

  async function mockSuccessfulCapture(page: Page) {
    await page.addInitScript(`window.__bugdropMockToPng = function() {
      window.__autoCaptureCount = (window.__autoCaptureCount || 0) + 1;
      return Promise.resolve('${STUB_PNG}');
    };`);
  }

  async function openForm(page: Page) {
    const host = page.locator('#bugdrop-host');
    await expect(host.locator('css=.bd-trigger')).toBeVisible({ timeout: 5000 });
    await host.locator('css=.bd-trigger').click();

    const getStartedBtn = host.locator('css=[data-action="continue"]');
    await expect(getStartedBtn).toBeVisible({ timeout: 5000 });
    await getStartedBtn.click();

    const titleInput = host.locator('css=#title');
    await expect(titleInput).toBeVisible({ timeout: 5000 });
    await titleInput.fill('Screenshot mode test');
    return host;
  }

  test('auto mode captures and submits a screenshot without the manual screenshot step', async ({
    page,
  }) => {
    await setupInstalledApp(page);
    await mockSuccessfulCapture(page);
    const getPayload = await setupSuccessfulSubmit(page);

    await page.goto('/test/?screenshot=auto');
    const host = await openForm(page);

    await expect(host.locator('css=#include-screenshot')).not.toBeAttached();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    await expect(host.locator('css=[data-action="capture"]')).not.toBeAttached();
    await expect(host.locator('css=#annotation-canvas')).not.toBeAttached();

    const payload = getPayload();
    expect(payload?.screenshot).toBe(STUB_PNG);
    expect(
      await page.evaluate(
        () => (window as Window & { __autoCaptureCount?: number }).__autoCaptureCount
      )
    ).toBe(1);
  });

  test('auto mode capture failure can skip without offering the manual picker', async ({
    page,
  }) => {
    await setupInstalledApp(page);
    await page.addInitScript(`window.__bugdropMockToPng = function() {
      return Promise.reject(new Error('auto capture failed'));
    };`);
    const getPayload = await setupSuccessfulSubmit(page);

    await page.goto('/test/?screenshot=auto');
    const host = await openForm(page);
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=.bd-error-message__text')).toContainText(
      'Failed to capture screenshot',
      { timeout: 5000 }
    );
    await expect(host.locator('css=[data-action="choose-again"]')).not.toBeAttached();
    await host.locator('css=[data-action="skip"]').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    expect(getPayload()?.screenshot).toBeNull();
  });

  test('auto mode warns users about automatic full-page screenshots', async ({ page }) => {
    await setupInstalledApp(page);
    await mockSuccessfulCapture(page);
    await setupSuccessfulSubmit(page);

    await page.goto('/test/redaction.html?screenshot=auto');
    const host = await openForm(page);

    await expect(host.locator('css=form')).toContainText(
      'This site will attach a full-page screenshot when you submit'
    );
    await expect(host.locator('css=form')).toContainText(
      'unmarked sensitive information can still be included'
    );
  });

  test('auto mode skips full-page capture on very complex pages', async ({ page }) => {
    await setupInstalledApp(page);
    await mockSuccessfulCapture(page);
    const getPayload = await setupSuccessfulSubmit(page);

    await page.goto('/test/complex-dom.html?nodes=12000&screenshot=auto');
    const host = await openForm(page);

    await expect(host.locator('css=#include-screenshot')).not.toBeAttached();
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    expect(getPayload()?.screenshot).toBeNull();
    expect(
      await page.evaluate(
        () => (window as Window & { __autoCaptureCount?: number }).__autoCaptureCount
      )
    ).toBeUndefined();
  });

  test('required mode removes the opt-out path and requires a capture before submit', async ({
    page,
  }) => {
    await setupInstalledApp(page);
    await mockSuccessfulCapture(page);
    const getPayload = await setupSuccessfulSubmit(page);

    await page.goto('/test/?screenshot=required');
    const host = await openForm(page);

    await expect(host.locator('css=#include-screenshot')).not.toBeAttached();
    await host.locator('css=#attachment-upload').setInputFiles({
      name: 'notes.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n'),
    });
    await expect(host.locator('css=.bd-upload-item')).toContainText('notes.pdf');
    await host.locator('css=#submit-btn').click();

    await expect(host.locator('css=[data-action="skip"]')).not.toBeAttached();
    await host.locator('css=[data-action="capture"]').click();

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 10000 });
    await host.locator('css=[data-action="done"]').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    const payload = getPayload();
    expect(payload?.screenshot).toEqual(expect.stringMatching(/^data:image\/png;base64,/));
    expect(payload?.attachments).toEqual([
      expect.objectContaining({
        name: 'notes.pdf',
        type: 'application/pdf',
        dataUrl: expect.stringMatching(/^data:application\/pdf;base64,/),
      }),
    ]);
  });

  test('annotation actions use distinct labels and submit from one primary action', async ({
    page,
  }) => {
    await setupInstalledApp(page);
    await mockSuccessfulCapture(page);
    const getPayload = await setupSuccessfulSubmit(page);

    await page.goto('/test/');
    const host = await openForm(page);

    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();
    await host.locator('css=[data-action="capture"]').click();

    const annotationModal = host.locator('css=.bd-modal--annotator');
    await expect(annotationModal).toBeVisible({ timeout: 10000 });
    const annotationActions = annotationModal.locator('css=.bd-actions [data-action]');
    await expect(annotationActions).toHaveCount(2);

    expect(
      await annotationActions.evaluateAll(buttons =>
        buttons.map(button => ({
          action: (button as HTMLElement).dataset.action,
          label: (button as HTMLElement).textContent?.trim(),
        }))
      )
    ).toEqual([
      { action: 'retake', label: 'Retake' },
      { action: 'done', label: 'Submit Feedback' },
    ]);

    await expect(annotationModal.locator('css=[data-action="skip"]')).toHaveCount(0);
    await expect(annotationModal.getByRole('button', { name: 'Skip Annotations' })).toHaveCount(0);

    await annotationModal.locator('css=[data-action="done"]').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });
    expect(getPayload()?.screenshot).toEqual(expect.stringMatching(/^data:image\/png;base64,/));
  });
});

test.describe('Screenshot Masking', () => {
  // Sample a single pixel from a base64 PNG payload via a page-side canvas.
  async function pixelAt(
    page: Page,
    dataUrl: string,
    x: number,
    y: number
  ): Promise<[number, number, number, number]> {
    return page.evaluate(
      ({ dataUrl, x, y }) =>
        new Promise<[number, number, number, number]>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const ctx = c.getContext('2d');
            if (!ctx) {
              reject(new Error('no ctx'));
              return;
            }
            ctx.drawImage(img, 0, 0);
            const px = ctx.getImageData(x, y, 1, 1).data;
            resolve([px[0], px[1], px[2], px[3]]);
          };
          img.onerror = () => reject(new Error('image load failed'));
          img.src = dataUrl;
        }),
      { dataUrl, x, y }
    );
  }

  // Read an element's bounding rect in document coordinates from the live page.
  async function docRectOf(page: Page, selector: string) {
    return page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no element matches ${sel}`);
      const r = el.getBoundingClientRect();
      return {
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        w: r.width,
        h: r.height,
      };
    }, selector);
  }

  async function shadowDocRectOf(page: Page, hostSelector: string, shadowSelector: string) {
    return page.locator(hostSelector).evaluate((host, selector) => {
      const el = host.shadowRoot?.querySelector(selector);
      if (!el) throw new Error(`no shadow element matches ${selector}`);
      const r = el.getBoundingClientRect();
      return {
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        w: r.width,
        h: r.height,
      };
    }, shadowSelector);
  }

  async function imagePixelRatio(page: Page, dataUrl: string): Promise<number> {
    return page.evaluate(
      url =>
        new Promise<number>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const vw = window.innerWidth;
            resolve(vw > 0 ? img.naturalWidth / vw : 1);
          };
          img.onerror = () => reject(new Error('image load failed'));
          img.src = url;
        }),
      dataUrl
    );
  }

  function mockHtmlToImage(page: Page, toPngBody: string) {
    return page.addInitScript(`window.__bugdropMockToPng = ${toPngBody};`);
  }

  function redactionAwarePng() {
    return `function(el, opts) {
      var canvas = document.createElement('canvas');
      var pixelRatio = opts && opts.pixelRatio ? opts.pixelRatio : 1;
      canvas.width = Math.max(1, Math.ceil((opts && opts.width ? opts.width : document.documentElement.scrollWidth) * pixelRatio));
      canvas.height = Math.max(1, Math.ceil((opts && opts.height ? opts.height : document.documentElement.scrollHeight) * pixelRatio));
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return Promise.resolve(canvas.toDataURL('image/png'));
    }`;
  }

  async function mockInstalledCheck(page: Page): Promise<void> {
    await page.route('**/api/check**', async route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      })
    );
  }

  // Walk the standard feedback flow up to a captured screenshot, returning the submitted payload.
  async function submitFeedbackWithFullPageCapture(
    page: Page,
    fixturePath: string
  ): Promise<{ screenshot: string; pixelRatio: number }> {
    let payload: Record<string, unknown> | null = null;
    await page.route('**/api/check**', async route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      })
    );
    await page.route('**/feedback', async route => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });

    await page.goto(fixturePath);
    const host = page.locator('#bugdrop-host');

    await host.locator('css=.bd-trigger').waitFor();
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();

    await host.locator('css=#title').fill('Mask test');

    // Opt in to screenshot capture.
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();

    // Choose Full Page capture.
    await expect(host.locator('css=[data-action="capture"]')).toBeVisible({ timeout: 5000 });
    await host.locator('css=[data-action="capture"]').click();

    // Wait for annotation step (proves capture+mask completed).
    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });

    // Submit annotated screenshot.
    await host.locator('css=[data-action="done"]').click();

    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

    if (!payload) throw new Error('no payload captured');

    // Derive the actual pixel ratio from the image dimensions rather than
    // window.devicePixelRatio, because the widget's getPixelRatio() enforces a
    // minimum scale of 2 regardless of the browser's DPR.
    const screenshotDataUrl = payload.screenshot as string;
    const pr = await imagePixelRatio(page, screenshotDataUrl);
    return { screenshot: screenshotDataUrl, pixelRatio: pr };
  }

  test('masks input[type=password] by default', async ({ page }) => {
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-basic.html'
    );

    const rect = await docRectOf(page, '#password');
    const cx = Math.floor((rect.x + rect.w / 2) * pixelRatio);
    const cy = Math.floor((rect.y + rect.h / 2) * pixelRatio);

    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('masks elements tagged with data-bugdrop-mask', async ({ page }) => {
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-basic.html'
    );

    const rect = await docRectOf(page, '#customer-panel');
    const cx = Math.floor((rect.x + rect.w / 2) * pixelRatio);
    const cy = Math.floor((rect.y + rect.h / 2) * pixelRatio);

    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('masks elements tagged with data-bugdrop-redact', async ({ page }) => {
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/redaction.html'
    );

    const rect = await docRectOf(page, '#redacted-test-input');
    const cx = Math.floor((rect.x + rect.w / 2) * pixelRatio);
    const cy = Math.floor((rect.y + rect.h / 2) * pixelRatio);

    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('does not mask unrelated elements', async ({ page }) => {
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-basic.html'
    );

    // Sample inside the panel's padding (top-left, ~3-4px in) where the yellow
    // background is guaranteed to be rendered without overlapping text. Sampling
    // the geometric center can land on anti-aliased glyph pixels in headless CI
    // and produce a spurious [0,0,0,255] match.
    const rect = await docRectOf(page, '#public-note');
    const sx = Math.floor((rect.x + 4) * pixelRatio);
    const sy = Math.floor((rect.y + 4) * pixelRatio);
    expect(await pixelAt(page, screenshot, sx, sy)).not.toEqual([0, 0, 0, 255]);
  });

  test('parent mask covers all descendants (inheritance)', async ({ page }) => {
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-nested.html'
    );

    // Sample inside the deeply-nested .inner-masked element — the OUTER mask
    // should already cover it, so this pixel must be opaque black.
    const innerRect = await docRectOf(page, '.inner-masked');
    const ix = Math.floor((innerRect.x + innerRect.w / 2) * pixelRatio);
    const iy = Math.floor((innerRect.y + innerRect.h / 2) * pixelRatio);
    expect(await pixelAt(page, screenshot, ix, iy)).toEqual([0, 0, 0, 255]);

    // Sibling area inside the masked outer container should also be covered.
    // Sample 5px below the outer top edge — still inside the mask but outside
    // any nested element.
    const outerRect = await docRectOf(page, '#outer-masked');
    const ox = Math.floor((outerRect.x + 10) * pixelRatio);
    const oy = Math.floor((outerRect.y + 5) * pixelRatio);
    expect(await pixelAt(page, screenshot, ox, oy)).toEqual([0, 0, 0, 255]);
  });

  test('masked child of unmasked parent is masked; siblings are not', async ({ page }) => {
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-nested.html'
    );

    const child = await docRectOf(page, '#masked-child');
    const cx = Math.floor((child.x + child.w / 2) * pixelRatio);
    const cy = Math.floor((child.y + child.h / 2) * pixelRatio);
    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);

    // The sibling is a <p> with no padding, so any pixel inside its rect could
    // overlap rendered glyphs and produce a spurious solid-black sample on
    // anti-aliased headless rendering. A real mask would make EVERY pixel inside
    // the rect solid black; sampling four corners and asserting at least one is
    // non-black is sufficient to disprove masking and is robust to text
    // rendering differences across environments.
    const sibling = await docRectOf(page, '#visible-sibling');
    const corners: Array<[number, number]> = [
      [sibling.x + 1, sibling.y + 1],
      [sibling.x + sibling.w - 2, sibling.y + 1],
      [sibling.x + 1, sibling.y + sibling.h - 2],
      [sibling.x + sibling.w - 2, sibling.y + sibling.h - 2],
    ];
    const samples = await Promise.all(
      corners.map(([x, y]) =>
        pixelAt(page, screenshot, Math.floor(x * pixelRatio), Math.floor(y * pixelRatio))
      )
    );
    const anyNonBlack = samples.some(px => !(px[0] === 0 && px[1] === 0 && px[2] === 0));
    expect(anyNonBlack).toBe(true);
  });

  test('scrolled full-page capture masks an element below the initial viewport', async ({
    page,
  }) => {
    // A scrolled variant of the helper — same flow, but scrolls AFTER goto so the page is
    // captured while the user is offset from the top.
    let payload: Record<string, unknown> | null = null;
    await page.route('**/api/check**', async route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      })
    );
    await page.route('**/feedback', async route => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });

    // Inject a tall spacer + a masked target below the fold AT page load.
    await page.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        const spacer = document.createElement('div');
        spacer.style.height = '2000px';
        spacer.id = 'spacer';
        const target = document.createElement('div');
        target.id = 'below-fold-mask';
        target.setAttribute('data-bugdrop-mask', '');
        target.style.cssText = 'width: 200px; height: 100px; background: #ccc;';
        target.textContent = 'sensitive';
        document.body.append(spacer, target);
      });
    });

    await page.goto('/test/masking-basic.html');
    await page.evaluate(() => window.scrollTo(0, 1500));

    const host = page.locator('#bugdrop-host');
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await host.locator('css=#title').fill('Scroll mask');
    // Note: in optional mode, the include-screenshot checkbox must be checked.
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();
    await host.locator('css=[data-action="capture"]').click();
    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });
    await host.locator('css=[data-action="done"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

    if (!payload) throw new Error('no payload');

    const screenshot = payload.screenshot as string;
    // Infer pixelRatio the same way the existing helper does (full-page capture):
    // naturalWidth / window.innerWidth.
    const pr = await page.evaluate(
      dataUrl =>
        new Promise<number>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth / window.innerWidth);
          img.onerror = () => reject(new Error('image load failed'));
          img.src = dataUrl;
        }),
      screenshot
    );

    const rect = await docRectOf(page, '#below-fold-mask');
    const cx = Math.floor((rect.x + rect.w / 2) * pr);
    const cy = Math.floor((rect.y + rect.h / 2) * pr);
    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('full-page capture masks transformed redaction targets', async ({ page }) => {
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-layout-edge.html'
    );

    const rect = await docRectOf(page, '#transformed-mask');
    const cx = Math.floor((rect.x + rect.w / 2) * pixelRatio);
    const cy = Math.floor((rect.y + rect.h / 2) * pixelRatio);

    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('full-page capture masks sticky redaction targets after scrolling', async ({ page }) => {
    await page.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        requestAnimationFrame(() => window.scrollTo(0, 420));
      });
    });

    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-layout-edge.html'
    );

    const rect = await docRectOf(page, '#sticky-mask');
    const cx = Math.floor((rect.x + rect.w / 2) * pixelRatio);
    const cy = Math.floor((rect.y + rect.h / 2) * pixelRatio);

    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('full-page capture masks fixed redaction targets after scrolling', async ({ page }) => {
    await page.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        requestAnimationFrame(() => window.scrollTo(0, 420));
      });
    });

    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-layout-edge.html'
    );

    const rect = await docRectOf(page, '#fixed-mask');
    const cx = Math.floor((rect.x + rect.w / 2) * pixelRatio);
    const cy = Math.floor((rect.y + rect.h / 2) * pixelRatio);

    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('masks explicit elements inside open shadow DOM', async ({ page }) => {
    await mockHtmlToImage(page, redactionAwarePng());
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-edge-surfaces.html'
    );

    const rect = await shadowDocRectOf(page, '#open-shadow-host', '#shadow-secret');

    expect(
      await pixelAt(
        page,
        screenshot,
        Math.floor((rect.x + rect.w / 2) * pixelRatio),
        Math.floor((rect.y + rect.h / 2) * pixelRatio)
      )
    ).toEqual([0, 0, 0, 255]);
  });

  test('masks a closed shadow custom element when the host is marked', async ({ page }) => {
    await mockHtmlToImage(page, redactionAwarePng());
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/masking-edge-surfaces.html'
    );

    const rect = await docRectOf(page, '#closed-shadow-host');
    expect(
      await pixelAt(
        page,
        screenshot,
        Math.floor((rect.x + rect.w / 2) * pixelRatio),
        Math.floor((rect.y + rect.h / 2) * pixelRatio)
      )
    ).toEqual([0, 0, 0, 255]);
  });

  test('warns when marked unsupported surfaces are covered by their element boxes', async ({
    page,
  }) => {
    await mockHtmlToImage(page, redactionAwarePng());
    await mockInstalledCheck(page);
    await page.goto('/test/masking-edge-surfaces.html');
    const host = page.locator('#bugdrop-host');

    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await host.locator('css=#title').fill('Surface warning');
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();
    await host.locator('css=[data-action="capture"]').click();

    const note = host.locator('css=.bd-redaction-note');
    await expect(note).toContainText('private');
    await expect(note).toContainText('BugDrop only covered the measured marked boxes');

    const canvasRect = await docRectOf(page, '#secret-canvas');
    const canvas = host.locator('css=#annotation-canvas canvas');
    const dataUrl = await canvas.evaluate(el => (el as HTMLCanvasElement).toDataURL('image/png'));
    const pixelRatio = await imagePixelRatio(page, dataUrl);
    expect(
      await pixelAt(
        page,
        dataUrl,
        Math.floor((canvasRect.x + canvasRect.w / 2) * pixelRatio),
        Math.floor((canvasRect.y + canvasRect.h / 2) * pixelRatio)
      )
    ).toEqual([0, 0, 0, 255]);
  });

  test('warns when a marked wrapper contains unsupported pixel-rendered descendants', async ({
    page,
  }) => {
    await mockHtmlToImage(page, redactionAwarePng());
    await mockInstalledCheck(page);
    await page.goto('/test/masking-edge-surfaces.html?fixture=wrapper-only');
    const host = page.locator('#bugdrop-host');

    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await host.locator('css=#title').fill('Wrapper warning');
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();
    await host.locator('css=[data-action="capture"]').click();

    await expect(host.locator('css=.bd-redaction-note')).toContainText(
      'BugDrop only covered the measured marked boxes',
      { timeout: 30000 }
    );

    const wrappedRect = await docRectOf(page, '#wrapped-secret-canvas');
    const canvas = host.locator('css=#annotation-canvas canvas');
    const dataUrl = await canvas.evaluate(el => (el as HTMLCanvasElement).toDataURL('image/png'));
    const pixelRatio = await imagePixelRatio(page, dataUrl);
    expect(
      await pixelAt(
        page,
        dataUrl,
        Math.floor((wrappedRect.x + wrappedRect.w / 2) * pixelRatio),
        Math.floor((wrappedRect.y + wrappedRect.h / 2) * pixelRatio)
      )
    ).toEqual([0, 0, 0, 255]);
  });

  test('selected-area capture warns only for unsupported marked surfaces inside the crop', async ({
    page,
  }) => {
    await mockHtmlToImage(page, redactionAwarePng());
    await mockInstalledCheck(page);
    await page.goto('/test/masking-edge-surfaces.html');
    const host = page.locator('#bugdrop-host');

    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await host.locator('css=#title').fill('Area includes unsupported surface');
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();
    await host.locator('css=[data-action="area"]').click();
    await expect(page.locator('#bugdrop-area-picker-overlay')).toBeVisible();

    const box = await page.locator('#secret-canvas').boundingBox();
    if (!box) throw new Error('secret canvas not found');
    await page.mouse.move(box.x - 8, box.y - 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 8, box.y + box.height + 8);
    await page.mouse.up();

    await expect(host.locator('css=.bd-redaction-note')).toContainText(
      'BugDrop only covered the measured marked boxes',
      { timeout: 30000 }
    );
  });

  test('selected-area capture does not warn for unsupported surfaces outside the crop', async ({
    page,
  }) => {
    await mockHtmlToImage(page, redactionAwarePng());
    await mockInstalledCheck(page);
    await page.goto('/test/masking-edge-surfaces.html');
    const host = page.locator('#bugdrop-host');

    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await host.locator('css=#title').fill('Area excludes unsupported surface');
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();
    await host.locator('css=[data-action="area"]').click();
    await expect(page.locator('#bugdrop-area-picker-overlay')).toBeVisible();

    const box = await page.locator('#custom-control').boundingBox();
    if (!box) throw new Error('custom control not found');
    await page.mouse.move(box.x - 8, box.y - 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 8, box.y + box.height + 8);
    await page.mouse.up();

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });
    await expect(host.locator('css=.bd-redaction-note')).not.toContainText(
      'BugDrop only covered the measured marked boxes',
      { timeout: 30000 }
    );
  });

  test('auto mode applies developer masks to the submitted screenshot', async ({ page }) => {
    let payload: Record<string, unknown> | null = null;
    await page.route('**/api/check**', async route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      })
    );
    await page.route('**/feedback', async route => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });

    await page.goto('/test/redaction.html?screenshot=auto');
    const host = page.locator('#bugdrop-host');
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await host.locator('css=#title').fill('Auto masked screenshot');
    await host.locator('css=#submit-btn').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 30000 });

    if (!payload?.screenshot || typeof payload.screenshot !== 'string') {
      throw new Error('expected screenshot payload');
    }

    const rect = await docRectOf(page, '#redacted-test-input');
    const pixelRatio = await imagePixelRatio(page, payload.screenshot);
    expect(
      await pixelAt(
        page,
        payload.screenshot,
        Math.floor((rect.x + rect.w / 2) * pixelRatio),
        Math.floor((rect.y + rect.h / 2) * pixelRatio)
      )
    ).toEqual([0, 0, 0, 255]);
  });

  test('full-page capture uses capture-start redaction geometry after DOM mutation', async ({
    page,
  }) => {
    await mockHtmlToImage(
      page,
      `function(el, opts) {
        window.__mutationCaptureRect = (function() {
          var target = document.querySelector('[data-bugdrop-redact]');
          var rect = target.getBoundingClientRect();
          return {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            w: rect.width,
            h: rect.height
          };
        })();
        document.querySelector('[data-bugdrop-redact]').remove();
        var canvas = document.createElement('canvas');
        var pixelRatio = opts && opts.pixelRatio ? opts.pixelRatio : 1;
        canvas.width = Math.ceil(document.documentElement.scrollWidth * pixelRatio);
        canvas.height = Math.ceil(document.documentElement.scrollHeight * pixelRatio);
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return Promise.resolve(canvas.toDataURL('image/png'));
      }`
    );

    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(
      page,
      '/test/redaction.html'
    );
    const originalRect = await page.evaluate(
      () =>
        (
          window as Window & {
            __mutationCaptureRect: { x: number; y: number; w: number; h: number };
          }
        ).__mutationCaptureRect
    );

    expect(
      await pixelAt(
        page,
        screenshot,
        Math.floor((originalRect.x + originalRect.w / 2) * pixelRatio),
        Math.floor((originalRect.y + originalRect.h / 2) * pixelRatio)
      )
    ).toEqual([0, 0, 0, 255]);
  });

  // Walk the element-picker flow and capture the chosen element.
  //
  // `selector` identifies the element to click in the picker.  The picker prefers
  // the nearest clickable ancestor and otherwise falls back to the deepest element
  // at the click point, so pass `clickOffset` when a fixture needs a precise target.
  // Defaults to the element's center.
  //
  // Returns the screenshot data URL and the image's natural pixel dimensions.
  // Dimensions are read from the image itself so they are always consistent with
  // the actual pixels — html-to-image uses clientWidth/clientHeight which can
  // differ from offsetWidth/offsetHeight when layout changes during capture.
  async function submitFeedbackWithElementCapture(
    page: Page,
    fixturePath: string,
    selector: string,
    clickOffset?: { x: number; y: number }
  ): Promise<{
    screenshot: string;
    imageSize: { w: number; h: number };
    metadata: {
      elementSelector?: string;
      fullElementSelector?: string;
      selectedElementHighlightColor?: string;
    };
  }> {
    let payload: Record<string, unknown> | null = null;
    await page.route('**/api/check**', async route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      })
    );
    await page.route('**/feedback', async route => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });

    await page.goto(fixturePath);
    const host = page.locator('#bugdrop-host');

    await host.locator('css=.bd-trigger').waitFor();
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await host.locator('css=#title').fill('Element scope test');
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();

    // Choose "Select Element".
    await host.locator('css=[data-action="element"]').click();

    // Wait for the element picker tooltip to confirm picker mode is active.
    await expect(page.locator('#bugdrop-element-picker-tooltip')).toBeVisible({ timeout: 5000 });

    // Click the target element using mouse coordinates. The picker intercepts
    // pointer events through its overlay, then resolves the page element under
    // that point.
    const target = page.locator(selector);
    await expect(target).toBeVisible({ timeout: 5000 });
    const targetBox = await target.boundingBox();
    if (!targetBox) throw new Error(`element not found or has no bounding box: ${selector}`);
    const clickX = targetBox.x + (clickOffset?.x ?? targetBox.width / 2);
    const clickY = targetBox.y + (clickOffset?.y ?? targetBox.height / 2);
    await page.mouse.move(clickX, clickY);
    await page.mouse.click(clickX, clickY);

    // Wait for annotation step.
    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });
    await host.locator('css=[data-action="done"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

    if (!payload) throw new Error('no payload captured');

    const screenshot = payload.screenshot as string;

    // Read the image's natural dimensions directly — these are ground truth for
    // any coordinate computation.
    const imageSize = await page.evaluate(
      dataUrl =>
        new Promise<{ w: number; h: number }>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => reject(new Error('image load failed'));
          img.src = dataUrl;
        }),
      screenshot
    );

    return {
      screenshot,
      imageSize,
      metadata: payload.metadata as {
        elementSelector?: string;
        fullElementSelector?: string;
        selectedElementHighlightColor?: string;
      },
    };
  }

  test('successful element capture submits a queryable full CSS path for dynamic repeated DOM', async ({
    page,
  }) => {
    const stubPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await page.addInitScript(png => {
      (
        window as Window & {
          __bugdropMockToPng?: () => Promise<string>;
        }
      ).__bugdropMockToPng = () => Promise.resolve(png);
    }, stubPng);
    await page.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        const fixture = document.createElement('section');
        fixture.id = 'dynamic-selector-fixture';
        fixture.style.cssText = [
          'position: fixed',
          'left: 72px',
          'top: 96px',
          'z-index: 10',
          'display: grid',
          'gap: 8px',
        ].join(';');
        fixture.innerHTML = Array.from(
          { length: 3 },
          (_, index) => `
            <article class="dynamic-card 3xl:panel" data-card-index="${index + 1}">
              <button class="action primary" data-dynamic-target="${index + 1}">
                Action ${index + 1}
              </button>
            </article>
          `
        ).join('');
        document.body.append(fixture);
      });
    });

    const { metadata } = await submitFeedbackWithElementCapture(
      page,
      '/test/',
      '[data-dynamic-target="2"]'
    );

    expect(metadata.elementSelector).toContain('#dynamic-selector-fixture');
    expect(metadata.elementSelector).toContain('button.action.primary');
    expect(metadata.selectedElementHighlightColor).toBe('#ff9e64');
    expect(metadata.fullElementSelector).toContain('html > body');
    expect(metadata.fullElementSelector).toContain('article.dynamic-card');
    expect(metadata.fullElementSelector).toContain(':nth-of-type(2)');
    expect(
      await page.evaluate(selector => {
        const target = document.querySelector('[data-dynamic-target="2"]');
        return Boolean(selector) && document.querySelector(selector) === target;
      }, metadata.fullElementSelector)
    ).toBe(true);
  });

  test('element-scoped capture masks descendant inside picked element', async ({ page }) => {
    // Click inside the top padding of #unmasked-parent (above the first <p> child)
    // so the picker resolves the parent, not a child element.
    // The 16px top padding gives ~8px of safe click area before the first child.
    const { screenshot, imageSize, metadata } = await submitFeedbackWithElementCapture(
      page,
      '/test/masking-nested.html',
      '#unmasked-parent',
      { x: 40, y: 8 } // 8px from top = within the 16px top padding
    );
    expect(metadata.elementSelector).toBe('#unmasked-parent');
    expect(metadata.fullElementSelector).toContain('html > body');
    expect(metadata.fullElementSelector).toContain('div#unmasked-parent');
    await expect(page.locator(`css=${metadata.fullElementSelector}`)).toHaveAttribute(
      'id',
      'unmasked-parent'
    );

    // Measure child geometry relative to the parent using the image's own scale.
    // The image width / parent clientWidth gives the pixelRatio used by html-to-image.
    const geometry = await page.evaluate(() => {
      const parent = document.querySelector('#unmasked-parent') as HTMLElement;
      const child = document.querySelector('#masked-child') as HTMLElement;
      const p = parent.getBoundingClientRect();
      const c = child.getBoundingClientRect();
      return {
        parentClientW: parent.clientWidth,
        childRelX: c.left - p.left,
        childRelY: c.top - p.top,
        childW: c.width,
        childH: c.height,
      };
    });

    const pr = imageSize.w / geometry.parentClientW;
    const cx = Math.floor((geometry.childRelX + geometry.childW / 2) * pr);
    const cy = Math.floor((geometry.childRelY + geometry.childH / 2) * pr);

    // Sanity check: the child must fall within the captured image height.
    expect(cy).toBeLessThan(imageSize.h);
    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('element-scoped capture masks the picked element itself', async ({ page }) => {
    const { screenshot, imageSize } = await submitFeedbackWithElementCapture(
      page,
      '/test/masking-nested.html',
      '#outer-masked'
    );

    // The mask covers the entire captured image (root element is masked).
    // Use the image center — guaranteed in-bounds regardless of pixelRatio.
    const cx = Math.floor(imageSize.w / 2);
    const cy = Math.floor(imageSize.h / 2);
    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('element-scoped capture masks a picked password input', async ({ page }) => {
    const { screenshot, imageSize } = await submitFeedbackWithElementCapture(
      page,
      '/test/masking-basic.html',
      '#password'
    );

    // The mask covers the entire captured image (password input is masked at root).
    const cx = Math.floor(imageSize.w / 2);
    const cy = Math.floor(imageSize.h / 2);
    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('area-cropped capture preserves masks inside the selected region', async ({ page }) => {
    let payload: Record<string, unknown> | null = null;
    await page.route('**/api/check**', async route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      })
    );
    await page.route('**/feedback', async route => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });

    await page.goto('/test/masking-basic.html');
    const host = page.locator('#bugdrop-host');

    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await host.locator('css=#title').fill('Area test');
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();

    // Read the customer-panel's viewport (client) rect BEFORE clicking "Select Area",
    // because the area picker overlay needs client coordinates (clientX/clientY).
    const clientRect = await page.evaluate(() => {
      const el = document.querySelector('#customer-panel');
      if (!el) throw new Error('no #customer-panel');
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const startX = clientRect.x - 10;
    const startY = clientRect.y - 10;
    const endX = clientRect.x + clientRect.w + 10;
    const endY = clientRect.y + clientRect.h + 10;
    const cropW = endX - startX;
    const cropH = endY - startY;

    await host.locator('css=[data-action="area"]').click();

    // Wait for the area picker overlay to appear (createAreaPicker has a 50ms delay).
    await expect(page.locator('#bugdrop-area-picker-overlay')).toBeVisible({ timeout: 5000 });

    // Drag a rectangle around the customer panel on the overlay.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.waitForTimeout(50);
    await page.mouse.move(endX, endY, { steps: 5 });
    await page.mouse.up();

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });
    await host.locator('css=[data-action="done"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

    if (!payload) throw new Error('no payload');

    // Infer pixelRatio from the cropped image. Cropped image width = cropW * pixelRatio.
    const screenshot = payload.screenshot as string;
    const pr = await page.evaluate(
      ({ dataUrl, w }) =>
        new Promise<number>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth / w);
          img.onerror = () => reject(new Error('image load failed'));
          img.src = dataUrl;
        }),
      { dataUrl: screenshot, w: cropW }
    );

    // The cropped image's geometric center should land inside the masked panel.
    const cx = Math.floor((cropW / 2) * pr);
    const cy = Math.floor((cropH / 2) * pr);
    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('scrolled area-cropped capture preserves masks at translated crop-local coordinates', async ({
    page,
  }) => {
    // Inject a tall spacer + a masked target below the fold.
    await page.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        const spacer = document.createElement('div');
        spacer.style.height = '2000px';
        const target = document.createElement('div');
        target.id = 'scrolled-mask';
        target.setAttribute('data-bugdrop-mask', '');
        target.style.cssText = 'width: 200px; height: 100px; background: #ccc;';
        target.textContent = 'sensitive';
        document.body.append(spacer, target);
      });
    });

    let payload: Record<string, unknown> | null = null;
    await page.route('**/api/check**', async route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ installed: true }),
      })
    );
    await page.route('**/feedback', async route => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 1, issueUrl: '#', isPublic: false }),
      });
    });

    await page.goto('/test/masking-basic.html');
    await page.evaluate(() => window.scrollTo(0, 1900));

    const host = page.locator('#bugdrop-host');
    await host.locator('css=.bd-trigger').click();
    await host.locator('css=[data-action="continue"]').click();
    await host.locator('css=#title').fill('Scrolled area test');
    await host.locator('css=#include-screenshot').check();
    await host.locator('css=#submit-btn').click();
    await host.locator('css=[data-action="area"]').click();

    // Wait for the area picker overlay (50ms initialization delay).
    await expect(page.locator('#bugdrop-area-picker-overlay')).toBeVisible({ timeout: 5000 });

    // Get viewport-coordinate rect of the masked element (it's now in the scrolled viewport).
    const targetClient = await page.evaluate(() => {
      const el = document.querySelector('#scrolled-mask') as HTMLElement;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });

    // Drag a rectangle around the masked target. Area picker uses CLIENT (viewport) coordinates.
    const startX = targetClient.x - 10;
    const startY = targetClient.y - 10;
    const endX = targetClient.x + targetClient.w + 10;
    const endY = targetClient.y + targetClient.h + 10;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.waitForTimeout(50);
    await page.mouse.move(endX, endY, { steps: 5 });
    await page.mouse.up();

    await expect(host.locator('css=#annotation-canvas')).toBeVisible({ timeout: 30000 });
    await host.locator('css=[data-action="done"]').click();
    await expect(host.locator('css=.bd-success-icon')).toBeVisible({ timeout: 10000 });

    if (!payload) throw new Error('no payload');
    const screenshot = payload.screenshot as string;

    // Cropped image's geometric center should be inside the masked target.
    const cropW = endX - startX;
    const cropH = endY - startY;
    const pr = await page.evaluate(
      ({ dataUrl, w }) =>
        new Promise<number>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth / w);
          img.onerror = () => reject(new Error('image load failed'));
          img.src = dataUrl;
        }),
      { dataUrl: screenshot, w: cropW }
    );
    const cx = Math.floor((cropW / 2) * pr);
    const cy = Math.floor((cropH / 2) * pr);
    expect(await pixelAt(page, screenshot, cx, cy)).toEqual([0, 0, 0, 255]);
  });

  test('clean baseline: page with no masked elements has no opaque-black sample at unrelated points', async ({
    page,
  }) => {
    const { screenshot, pixelRatio } = await submitFeedbackWithFullPageCapture(page, '/test/');

    // Sample a handful of points; none should be exactly [0,0,0,255]. The standard fixture
    // contains no masking attributes, so any solid-black 1px sample at these coordinates
    // would be a regression.
    const samplePoints: Array<[number, number]> = [
      [10, 10],
      [50, 50],
      [200, 100],
    ];

    for (const [x, y] of samplePoints) {
      const px = await pixelAt(
        page,
        screenshot,
        Math.floor(x * pixelRatio),
        Math.floor(y * pixelRatio)
      );
      expect(px).not.toEqual([0, 0, 0, 255]);
    }
  });
});
