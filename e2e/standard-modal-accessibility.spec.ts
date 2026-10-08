import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/check**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"installed":true}' })
  );
});

test('standard feedback form owns focus and restores the host page on Escape', async ({ page }) => {
  await page.goto('/test/welcome-disabled.html');
  await page.evaluate(() => {
    const opener = document.createElement('button');
    opener.id = 'host-feedback';
    opener.textContent = 'Share feedback';
    opener.addEventListener('click', () => window.BugDrop?.open());
    document.body.appendChild(opener);

    const alreadyInert = document.createElement('button');
    alreadyInert.id = 'already-inert';
    alreadyInert.inert = true;
    document.body.appendChild(alreadyInert);
  });

  const opener = page.locator('#host-feedback');
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Send Feedback' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#bugdrop-host').locator('#title')).toBeFocused();
  await expect(opener).toHaveAttribute('inert', '');
  const cdp = await page.context().newCDPSession(page);
  const ax = await cdp.send('Accessibility.getFullAXTree');
  expect(ax.nodes.some(node => node.name?.value === 'Welcome Disabled Test')).toBe(false);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden');

  const close = dialog.getByRole('button', { name: 'Close' });
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.locator('#submit-btn')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(opener).not.toHaveAttribute('inert', '');
  await expect(page.locator('#already-inert')).toHaveAttribute('inert', '');
  await expect
    .poll(async () => {
      const restored = await cdp.send('Accessibility.getFullAXTree');
      return restored.nodes.some(node => node.name?.value === 'Welcome Disabled Test');
    })
    .toBe(true);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
});

test('standard welcome to form transition keeps modal focus and closes from the form', async ({
  page,
}) => {
  await page.goto('/test/');
  const trigger = page.locator('#bugdrop-host').locator('.bd-trigger');
  await trigger.click();

  const welcome = page.getByRole('dialog');
  await expect(welcome).toBeVisible();
  await welcome.getByRole('button', { name: 'Get Started' }).click();

  const form = page.getByRole('dialog', { name: 'Send Feedback' });
  await expect(form).toBeVisible();
  await expect(form.locator('#title')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('programmatic close removes the standard backdrop and restores focus', async ({ page }) => {
  await page.goto('/test/welcome-disabled.html');
  const trigger = page.locator('#bugdrop-host').locator('.bd-trigger');
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Send Feedback' })).toBeVisible();

  await page.evaluate(() => window.BugDrop?.close());
  await expect(page.locator('#bugdrop-host').locator('.bd-overlay')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
});

test('programmatic close during screenshot selection does not reopen feedback', async ({
  page,
}) => {
  await page.goto('/test/welcome-disabled.html');
  const trigger = page.locator('#bugdrop-host').locator('.bd-trigger');
  await trigger.click();
  const form = page.getByRole('dialog', { name: 'Send Feedback' });
  await form.locator('#title').fill('Screenshot close regression');
  await form.locator('#include-screenshot').check();
  await form
    .locator('#feedback-form')
    .evaluate(element =>
      element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    );
  await expect(page.getByRole('dialog', { name: 'Capture Screenshot' })).toBeVisible();

  await page.evaluate(() => window.BugDrop?.close());
  await expect(page.locator('#bugdrop-host').locator('.bd-overlay')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.BugDrop?.isOpen())).toBe(false);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  await expect(trigger).toBeFocused();
});
