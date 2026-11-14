import { expect, test, type Locator, type Page } from '@playwright/test';

async function expectTabOnEdge(page: Page, button: Locator, edge: 'left' | 'right') {
  await expect(button).toBeVisible();
  await button.evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished));
  });
  const box = (await button.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.width).toBe(44);
  expect(box.height).toBeGreaterThan(box.width);
  expect(edge === 'left' ? box.x : box.x + box.width).toBeCloseTo(
    edge === 'left' ? 0 : viewport.width,
    0
  );
  expect(box.y + box.height / 2).toBeCloseTo(viewport.height * 0.65, 0);
}

test('a right-side feedback tab ignores the saved horizontal launcher position', async ({
  page,
}) => {
  await page.route('**/api/check**', route => route.fulfill({ json: { installed: true } }));
  await page.goto('/test/');
  const repo = await page.locator('#bugdrop-script').getAttribute('data-repo');
  const positionKey = `bugdrop_trigger_position_${repo}_bottom-right`;
  await page.evaluate(key => localStorage.setItem(key, '40'), positionKey);

  await page.goto('/test/?buttonStyle=tab&theme=light');
  const host = page.locator('#bugdrop-host');
  const button = host.getByRole('button', { name: 'Feedback', exact: true });

  await expectTabOnEdge(page, button, 'right');
  await expect(button).toHaveCSS('background-color', 'rgb(255, 158, 100)');
  await expect(button).toHaveCSS('color', /rgb\((0, 0, 0|15, 23, 42)\)/);
  await expect(button.locator('.bd-trigger-label')).toHaveCSS('writing-mode', 'vertical-rl');
  await expect(button.locator('.bd-trigger-icon, .bd-trigger-drag-handle')).toHaveCount(0);
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(host.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(host.getByRole('dialog')).toHaveCount(0);
  await expect(button).toBeFocused();

  await page.goto('/test/');
  const horizontal = host.locator('.bd-trigger');
  await expect(horizontal).toHaveCSS('top', '40px');
  await expect(horizontal).toHaveCSS('background-color', 'rgb(255, 158, 100)');
  await expect(horizontal.locator('.bd-trigger-drag-handle')).toBeVisible();
});

test.describe('on a narrow touch viewport', () => {
  test.use({ viewport: { width: 375, height: 260 }, hasTouch: true, isMobile: true });

  test('a left-side tab can be dismissed and restored after reload', async ({ page }) => {
    await page.goto(
      '/test/?buttonStyle=tab&position=bottom-left&label=Send%20feedback&buttonDismissible=true'
    );
    const host = page.locator('#bugdrop-host');
    const button = host.getByRole('button', { name: 'Send feedback', exact: true });
    const restore = host.getByRole('button', { name: 'Show feedback button' });

    await expectTabOnEdge(page, button, 'left');
    await host.getByRole('button', { name: 'Dismiss feedback button' }).tap();
    await expect(button).toHaveCount(0);
    await expect(restore).toBeVisible();
    await restore.evaluate(async el => {
      await Promise.all(el.getAnimations().map(animation => animation.finished));
    });
    const restoreBox = (await restore.boundingBox())!;
    expect(restoreBox.y + restoreBox.height / 2).toBeCloseTo(260 * 0.65, 0);
    await page.reload();
    await expect(button).toHaveCount(0);
    await restore.tap();
    await expectTabOnEdge(page, button, 'left');
  });
});
