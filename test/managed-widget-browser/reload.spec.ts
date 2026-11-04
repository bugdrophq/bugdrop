import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';

const app = 'https://reload-app.localhost';
const widget = 'https://reload-widget.localhost';
interface SetupOptions {
  rejectRetry?: boolean;
  failAuthorizationCalls?: number[];
  pendingAuthorization?: boolean;
  response?: 'delivered' | 'internal_error';
}
async function setup(page: Page, options: SetupOptions = {}) {
  const [sdk, script] = await Promise.all([
    readFile('dist/managed-widget/packed-sdk.js', 'utf8'),
    readFile('dist/managed-widget/widget.managed.v1.js', 'utf8'),
  ]);
  let attempts = 0;
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url === `${app}/`)
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><main>Customer</main>',
      });
    else if (url === `${widget}/widget.managed.v1.js`)
      await route.fulfill({ contentType: 'application/javascript', body: script });
    else if (url === `${widget}/v1/submissions`) {
      if (route.request().method() === 'OPTIONS')
        await route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': app,
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-BugDrop-Submission-Id',
          },
        });
      else {
        attempts++;
        if (options.rejectRetry && attempts > 1)
          await route.fulfill({
            status: 403,
            headers: { 'Access-Control-Allow-Origin': app },
            contentType: 'application/json',
            body: JSON.stringify({
              schemaVersion: 1,
              error: { code: 'forbidden', retryable: false },
            }),
          });
        else if (options.response)
          await route.fulfill({
            status: options.response === 'delivered' ? 200 : 500,
            headers: { 'Access-Control-Allow-Origin': app },
            contentType: 'application/json',
            body: JSON.stringify(
              options.response === 'delivered'
                ? {
                    schemaVersion: 1,
                    status: 'delivered',
                    receiptId: '00000000-0000-4000-8000-000000000001',
                  }
                : { schemaVersion: 1, error: { code: 'internal_error', retryable: true } }
            ),
          });
        else await route.abort('failed');
      }
    } else throw new Error(`Unexpected request: ${url}`);
  });
  async function boot() {
    await page.addScriptTag({ content: sdk });
    await page.evaluate(
      async ({ widget, failAuthorizationCalls, pendingAuthorization }) => {
        const fixture = window as unknown as {
          authorizationCalls: number;
          bindings: unknown[];
          PackedBugDrop: {
            init(options: unknown): { ready: Promise<void>; open(): Promise<void> };
          };
        };
        fixture.authorizationCalls = 0;
        fixture.bindings = [];
        const controller = fixture.PackedBugDrop.init({
          applicationId: 'app_reload',
          widgetUrl: `${widget}/widget.managed.v1.js`,
          tokenProvider: (binding: unknown) => {
            fixture.bindings.push(binding);
            fixture.authorizationCalls++;
            if (failAuthorizationCalls.includes(fixture.authorizationCalls))
              throw new Error('Synthetic authorization failure');
            if (pendingAuthorization) return new Promise(() => {});
            return {
              schemaVersion: 1,
              token: 'synthetic-token',
              expiresAt: new Date(Date.now() + 120000).toISOString(),
            };
          },
        });
        await controller.ready;
        await controller.open();
      },
      {
        widget,
        failAuthorizationCalls: options.failAuthorizationCalls ?? [],
        pendingAuthorization: options.pendingAuthorization ?? false,
      }
    );
  }
  await page.goto(app);
  await boot();
  return { boot, attempts: () => attempts, host: page.locator('#bugdrop-managed-host') };
}

test('lost response followed by cold reload blocks a replacement report', async ({ page }) => {
  const fixture = await setup(page);
  await fixture.host.locator('input[name="title"]').fill('Potential duplicate');
  await fixture.host
    .locator('textarea[name="description"]')
    .fill('Private report text must not persist');
  await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(
    fixture.host.getByRole('button', { name: 'Check result', exact: true })
  ).toBeVisible();
  expect(fixture.attempts()).toBe(1);
  await page.reload();
  await fixture.boot();
  await expect(fixture.host.locator('[data-role="status"]')).toContainText(
    'Contact the site owner'
  );
  await expect(fixture.host.locator('form')).toBeHidden();
  await expect(fixture.host.locator('[data-action="check-result"]')).toBeHidden();
  await expect(fixture.host.locator('[data-action="new-report"]')).toBeHidden();
  await fixture.host
    .locator('form')
    .evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(fixture.attempts()).toBe(1);
  const stored = await page.evaluate(() =>
    JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) })
  );
  expect(stored).not.toContain('Private report');
  expect(stored).not.toContain('synthetic-token');
});

for (const failure of ['unavailable', 'corrupt', 'no-locks']) {
  test(`blocks submission when recovery state is ${failure}`, async ({ page }) => {
    await page.addInitScript(failure => {
      if (failure === 'unavailable')
        Object.defineProperty(window, 'localStorage', {
          get() {
            throw new Error('Storage denied');
          },
        });
      else if (failure === 'no-locks')
        Object.defineProperty(navigator, 'locks', { value: undefined });
      else
        localStorage.setItem(
          `bugdrop:unresolved:v1:${JSON.stringify(['app_reload', 'https://reload-widget.localhost/v1/submissions'])}`,
          'corrupt'
        );
    }, failure);
    const fixture = await setup(page);
    await expect(fixture.host.locator('[data-role="status"]')).toContainText(
      'Contact the site owner'
    );
    await expect(fixture.host.locator('form')).toBeHidden();
    expect(fixture.attempts()).toBe(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { authorizationCalls: number }).authorizationCalls
      )
    ).toBe(0);
  });
}

test('two tabs cannot start competing reports in one Application', async ({ page, context }) => {
  const otherPage = await context.newPage();
  const first = await setup(page);
  const second = await setup(otherPage);
  for (const fixture of [first, second]) {
    await fixture.host.locator('input[name="title"]').fill('Same report');
    await fixture.host.locator('textarea[name="description"]').fill('Concurrent submit');
  }
  await Promise.all(
    [first, second].map(fixture =>
      fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click()
    )
  );
  await expect
    .poll(async () => {
      const values = await Promise.all(
        [first, second].map(fixture => fixture.host.locator('[data-role="status"]').textContent())
      );
      return values.filter(value => value?.includes('Contact the site owner')).length;
    })
    .toBe(1);
  await expect.poll(() => first.attempts() + second.attempts()).toBe(1);
});

test('a denial after uncertainty cannot unlock a cold reload', async ({ page }) => {
  const fixture = await setup(page, { rejectRetry: true });
  await fixture.host.locator('input[name="title"]').fill('Unresolved report');
  await fixture.host.locator('textarea[name="description"]').fill('Revoked during recovery');
  await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await fixture.host.getByRole('button', { name: 'Check result', exact: true }).click();
  await expect.poll(() => fixture.attempts()).toBe(2);
  await expect(
    fixture.host.getByRole('button', { name: 'Check result', exact: true })
  ).toBeVisible();
  await page.reload();
  await fixture.boot();
  await expect(fixture.host.locator('[data-role="status"]')).toContainText(
    'Contact the site owner'
  );
  await expect(fixture.host.locator('form')).toBeHidden();
  expect(fixture.attempts()).toBe(2);
});

test('a failed durable write prevents authorization and delivery', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error('Quota exceeded');
    };
  });
  const fixture = await setup(page);
  await fixture.host.locator('input[name="title"]').fill('Must not send');
  await fixture.host.locator('textarea[name="description"]').fill('Storage is full');
  await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(fixture.host.locator('[data-role="status"]')).toContainText(
    'Contact the site owner'
  );
  expect(fixture.attempts()).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { authorizationCalls: number }).authorizationCalls
    )
  ).toBe(0);
});

test('authorization-only failure permits a fresh draft after reload without submitting', async ({
  page,
}) => {
  const fixture = await setup(page, { failAuthorizationCalls: [1] });
  await fixture.host.locator('input[name="title"]').fill('Not dispatched');
  await fixture.host.locator('textarea[name="description"]').fill('Authorization is unavailable');
  await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(fixture.host.locator('[data-role="status"]')).toContainText('Unable to authorize');
  expect(fixture.attempts()).toBe(0);
  await page.reload();
  await fixture.boot();
  await expect(fixture.host.locator('form')).toBeVisible();
  expect(fixture.attempts()).toBe(0);
});

test('manual retry after authorization failure preserves the prepared report', async ({ page }) => {
  const fixture = await setup(page, { failAuthorizationCalls: [1], response: 'delivered' });
  await fixture.host.locator('input[name="title"]').fill('Retry authorization');
  await fixture.host.locator('textarea[name="description"]').fill('Same frozen report');
  await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await fixture.host.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(fixture.host.locator('[data-role="status"]')).toHaveText('Feedback delivered.');
  expect(fixture.attempts()).toBe(1);
  const bindings = await page.evaluate(
    () => (window as unknown as { bindings: unknown[] }).bindings
  );
  expect(bindings).toHaveLength(2);
  expect(bindings[1]).toEqual(bindings[0]);
  await page.reload();
  await fixture.boot();
  await expect(fixture.host.locator('form')).toBeVisible();
});

for (const response of [undefined, 'internal_error'] as const) {
  test(`${response ?? 'lost response'} then authorization failure retains the reload lock`, async ({
    page,
  }) => {
    const fixture = await setup(page, { failAuthorizationCalls: [2], response });
    await fixture.host.locator('input[name="title"]').fill('Previously dispatched');
    await fixture.host.locator('textarea[name="description"]').fill('Do not replace this report');
    await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
    await fixture.host.locator('[data-action="check-result"]').click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { authorizationCalls: number }).authorizationCalls
        )
      )
      .toBe(2);
    await expect(fixture.host.locator('[data-role="status"]')).toContainText(
      response ? 'Unable to authorize' : 'could not be confirmed'
    );
    expect(fixture.attempts()).toBe(1);
    await page.reload();
    await fixture.boot();
    await expect(fixture.host.locator('[data-role="status"]')).toContainText(
      'Contact the site owner'
    );
    await expect(fixture.host.locator('form')).toBeHidden();
    expect(fixture.attempts()).toBe(1);
  });
}

test('reload during pending authorization retains the unresolved lock', async ({ page }) => {
  const fixture = await setup(page, { pendingAuthorization: true });
  await fixture.host.locator('input[name="title"]').fill('Still authorizing');
  await fixture.host.locator('textarea[name="description"]').fill('No settled result yet');
  await fixture.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { authorizationCalls: number }).authorizationCalls)
    )
    .toBe(1);
  await page.reload();
  await fixture.boot();
  await expect(fixture.host.locator('[data-role="status"]')).toContainText(
    'Contact the site owner'
  );
  await expect(fixture.host.locator('form')).toBeHidden();
  expect(fixture.attempts()).toBe(0);
});

test('a retry cannot bypass another tab that acquired the released marker', async ({
  page,
  context,
}) => {
  const first = await setup(page, { failAuthorizationCalls: [1] });
  await first.host.locator('input[name="title"]').fill('First draft');
  await first.host.locator('textarea[name="description"]').fill('Failed authorization');
  await first.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(first.host.locator('[data-role="status"]')).toContainText('Unable to authorize');
  const otherPage = await context.newPage();
  const second = await setup(otherPage);
  await second.host.locator('input[name="title"]').fill('Other tab');
  await second.host.locator('textarea[name="description"]').fill('Now owns the marker');
  await second.host.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(second.host.locator('[data-action="check-result"]')).toBeVisible();
  await first.host.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(first.host.locator('[data-role="status"]')).toContainText('Contact the site owner');
  expect(first.attempts()).toBe(0);
  expect(second.attempts()).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { authorizationCalls: number }).authorizationCalls
    )
  ).toBe(1);
});
