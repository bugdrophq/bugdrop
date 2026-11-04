import { expect, test } from '@playwright/test';
import { contextDefaultFlow } from '../test/fixtures/context-default-flow';

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 393, height: 852 },
]) {
  test.describe(`context default routing at ${viewport.width}px`, () => {
    test.use({ viewport });
    for (const type of ['shortText', 'longText'] as const) {
      for (const contextName of ['Alice', ' Alice ']) {
        test(`untouched ${type} default ${JSON.stringify(contextName)} updates navigation before clicking`, async ({
          page,
        }) => {
          const payloads: Array<{ description: string }> = [];
          await page.route('**/api/check/**', route =>
            route.fulfill({
              json: { installed: true },
            })
          );
          await page.route('**/api/feedback', route => {
            payloads.push(route.request().postDataJSON());
            return route.fulfill({
              json: {
                success: true,
                issueNumber: 1,
                issueUrl: 'https://github.com/example/feedback/issues/1',
                isPublic: false,
              },
            });
          });
          await page.goto('/test/welcome-disabled.html');
          await expect
            .poll(() => page.evaluate(() => typeof window.BugDrop?.registerFlow))
            .toBe('function');
          await page.evaluate(
            ({ config, name }) => {
              window.BugDrop!.registerFlow(config).open({ context: { name } });
            },
            { config: contextDefaultFlow(type), name: contextName }
          );
          const dialog = page.getByRole('dialog');
          const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
          await expect(name).toHaveValue('Alice');
          await expect(dialog.getByText('Step 1 of 2', { exact: true })).toBeVisible();
          await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
          await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toHaveCount(0);
          expect(payloads).toHaveLength(0);
          await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
          await expect(
            dialog.getByRole('heading', { name: 'Follow-up for Alice', exact: true })
          ).toBeVisible();
          expect(payloads).toHaveLength(0);
          await dialog
            .getByRole('textbox', { name: 'Response', exact: true })
            .fill('Abandoned follow-up');
          await dialog.getByRole('button', { name: 'Back', exact: true }).click();
          await name.fill('');
          await expect(dialog.getByText('Step 1 of 1', { exact: true })).toBeVisible();
          await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeVisible();
          await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
          await expect.poll(() => payloads.length).toBe(1);
          expect(payloads[0].description).not.toContain('Alice');
          expect(payloads[0].description).not.toContain('Abandoned follow-up');
        });
      }
    }
  });
}
