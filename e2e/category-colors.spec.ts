import { test, expect } from '@playwright/test';

for (const theme of ['dark', 'light'] as const) {
  test(`category labels follow ${theme} theme instead of host text`, async ({ page }, testInfo) => {
    await page.route('**/api/check**', route => route.fulfill({ json: { installed: true } }));
    await page.goto(`/test/?theme=${theme}`);
    await page.evaluate(
      color => {
        document.body.style.color = color;
      },
      theme === 'dark' ? '#222' : '#eee'
    );

    const host = page.locator('#bugdrop-host');
    await host.locator('.bd-trigger').click();
    await host.locator('[data-action="continue"]').click();
    const labels = host.locator('.bd-category-option span');
    await expect(labels).toHaveCount(3);
    await expect(labels.first()).toBeVisible();
    await host.locator('.bd-modal').screenshot({ path: testInfo.outputPath('categories.png') });

    const initialColor = theme === 'dark' ? 'rgb(241, 245, 249)' : 'rgb(28, 25, 23)';
    for (const label of await labels.all()) await expect(label).toHaveCSS('color', initialColor);

    // A host style change must not affect an already-open form.
    await page.evaluate(() => {
      document.body.style.color = '#ff0000';
    });
    for (const label of await labels.all()) await expect(label).toHaveCSS('color', initialColor);

    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    await page.evaluate(mode => {
      (window as Window & { BugDrop: { setTheme: (mode: string) => void } }).BugDrop.setTheme(mode);
    }, nextTheme);
    const nextColor = nextTheme === 'dark' ? 'rgb(241, 245, 249)' : 'rgb(28, 25, 23)';
    for (const label of await labels.all()) await expect(label).toHaveCSS('color', nextColor);
  });
}
