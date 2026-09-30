import { expect, test, type Page } from '@playwright/test';

const widget = (page: Page) => page.locator('#bugdrop-host');

async function prepare(page: Page, runtime: 'fixed' | 'private') {
  await page.addInitScript(selected => {
    const host = window as unknown as Record<string, unknown>;
    host.__bugdropDefaultFlowRuntime = selected;
    host.profile = { name: '<Mira & Co>', email: 'mira@example.com' };
    host.calls = 0;
    host.getPrefill = () => {
      host.calls = Number(host.calls) + 1;
      return {
        ...(host.profile as object),
        descriptionTemplates: {
          bug: '<bug & literal>',
          feature: 'Feature idea',
          question: 'Ask away',
        },
      };
    };
  }, runtime);
  await page.route('**/test/**', async route => {
    if (new URL(route.request().url()).pathname !== '/test/') return route.continue();
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "showEmail: 'showEmail',",
      "showEmail: 'showEmail', prefillProvider: 'prefillProvider',"
    );
    await route.fulfill({ response, body });
  });
  await page.route('**/api/check**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"installed":true}' })
  );
}

test('built-in reporter edits stop at the Worker identity limits', async ({ page }) => {
  await prepare(page, 'fixed');
  await page.goto('/test/?showName=true&showEmail=true&prefillProvider=getPrefill');
  await widget(page).locator('css=.bd-trigger').click();
  await widget(page).locator('css=[data-action="continue"]').click();
  const name = widget(page).locator('css=#name');
  const email = widget(page).locator('css=#email');
  await expect(name).toHaveAttribute('maxlength', '100');
  await expect(email).toHaveAttribute('maxlength', '254');
  await name.fill('');
  await name.pressSequentially('n'.repeat(101));
  await expect(name).toHaveValue('n'.repeat(100));
});

for (const runtime of ['fixed', 'private'] as const) {
  for (const entry of ['trigger', 'open'] as const) {
    test(`${runtime} ${entry} uses fresh prefills and preserves edits through screenshot return`, async ({
      page,
    }) => {
      await prepare(page, runtime);
      await page.goto('/test/?showName=true&showEmail=true&prefillProvider=getPrefill');
      await expect(widget(page).locator('css=.bd-trigger')).toBeVisible();
      if (entry === 'trigger') {
        await widget(page).locator('css=.bd-trigger').click();
        await widget(page).locator('css=[data-action="continue"]').click();
      } else {
        await page.evaluate(() =>
          (window.BugDrop?.open as (...args: unknown[]) => void)({
            name: 'ignored',
          })
        );
      }
      const description = widget(page).locator('css=#description');
      await expect(description).toHaveValue('<bug & literal>');
      await expect(widget(page).locator('css=#name')).toHaveValue('<Mira & Co>');
      await expect(widget(page).locator('css=#email')).toHaveValue('mira@example.com');
      expect(await widget(page).locator('css=#name').getAttribute('value')).toBeNull();
      expect(await widget(page).locator('css=#email').getAttribute('value')).toBeNull();
      await expect(widget(page).locator('css=.bd-field-hint')).toContainText('GitHub Issue');
      await expect(widget(page).locator('css=#email')).toHaveAttribute(
        'aria-describedby',
        'bd-prefilled-email-disclosure'
      );
      await widget(page).locator('css=input[name="category"][value="feature"]').check();
      await expect(description).toHaveValue('Feature idea');
      await description.fill('');
      await widget(page).locator('css=input[name="category"][value="question"]').check();
      await expect(description).toHaveValue('');
      await widget(page).locator('css=#name').fill('');
      await widget(page).locator('css=#email').fill('');
      await widget(page).locator('css=#title').fill('Report');
      await widget(page).locator('css=#include-screenshot').check();
      await widget(page).locator('css=#submit-btn').click();
      await expect(widget(page).locator('css=[data-action="capture"]')).toBeVisible();
      await widget(page).locator('css=.bd-close').click();
      await expect(description).toHaveValue('');
      await widget(page).locator('css=input[name="category"][value="bug"]').check();
      await expect(description).toHaveValue('');
      await expect(widget(page).locator('css=#name')).toHaveValue('');
      await expect(widget(page).locator('css=#email')).toHaveValue('');
      expect(await widget(page).locator('css=#name').getAttribute('value')).toBeNull();
      expect(await widget(page).locator('css=#email').getAttribute('value')).toBeNull();
      await description.fill('Reporter-authored detail');
      await widget(page).locator('css=input[name="category"][value="feature"]').check();
      await expect(description).toHaveValue('Reporter-authored detail');
      await widget(page).locator('css=#submit-btn').click();
      await widget(page).locator('css=.bd-close').click();
      await expect(description).toHaveValue('Reporter-authored detail');
      await expect(widget(page).locator('css=#name')).toHaveValue('');
      await expect(widget(page).locator('css=#email')).toHaveValue('');
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).calls)).toBe(
        1
      );
      await page.evaluate(() => {
        window.BugDrop?.close();
        (window as unknown as Record<string, unknown>).profile = {
          name: 'Next',
          email: 'next@example.com',
        };
        window.BugDrop?.open();
      });
      await expect(widget(page).locator('css=#name')).toHaveValue('Next');
      expect(await widget(page).locator('css=#name').getAttribute('value')).toBeNull();
      await expect(description).toHaveValue('<bug & literal>');
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).calls)).toBe(
        2
      );
    });
  }
}

for (const runtime of ['fixed', 'private'] as const) {
  test(`${runtime} submits each category template and visible prefilled identity`, async ({
    page,
  }) => {
    await prepare(page, runtime);
    const requests: Array<Record<string, unknown>> = [];
    await page.route('**/api/feedback', route => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 42, isPublic: false }),
      });
    });
    for (const [category, expected] of [
      ['bug', '<bug & literal>'],
      ['feature', 'Feature idea'],
      ['question', 'Ask away'],
    ] as const) {
      await page.goto('/test/?showName=true&showEmail=true&prefillProvider=getPrefill');
      await page.waitForFunction(() => Boolean(window.BugDrop));
      await page.evaluate(() => window.BugDrop?.open());
      if (category !== 'bug') {
        await widget(page).locator(`css=input[name="category"][value="${category}"]`).check();
      }
      await expect(widget(page).locator('css=#description')).toHaveValue(expected);
      await widget(page).locator('css=#title').fill(`Report ${category}`);
      await widget(page).locator('css=#include-screenshot').uncheck();
      await widget(page).locator('css=#submit-btn').click();
      await expect(widget(page).locator('css=.bd-success-icon')).toBeVisible();
      expect(requests.at(-1)).toMatchObject({
        title: `Report ${category}`,
        description: expected,
        category,
        submitter: { name: '<Mira & Co>', email: 'mira@example.com' },
      });
    }
    expect(requests).toHaveLength(3);
  });
}

test('an untouched description clears when the selected category has no template', async ({
  page,
}) => {
  await prepare(page, 'fixed');
  await page.goto('/test/?prefillProvider=getPrefill');
  await page.waitForFunction(() => Boolean(window.BugDrop));
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).getPrefill = () => ({
      descriptionTemplates: { bug: 'Bug prompt' },
    });
    window.BugDrop?.open();
  });
  const description = widget(page).locator('css=#description');
  await expect(description).toHaveValue('Bug prompt');
  await widget(page).locator('css=input[name="category"][value="feature"]').check();
  await expect(description).toHaveValue('');
});

test('clearing a prefilled email omits it from the actual feedback request', async ({ page }) => {
  await prepare(page, 'fixed');
  const requests: Array<Record<string, unknown>> = [];
  await page.route('**/api/feedback', route => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, issueNumber: 42, isPublic: false }),
    });
  });
  await page.goto('/test/?showName=true&showEmail=true&prefillProvider=getPrefill');
  await page.waitForFunction(() => Boolean(window.BugDrop));
  await page.evaluate(() => window.BugDrop?.open());
  await expect(widget(page).locator('css=#email')).toHaveValue('mira@example.com');
  await widget(page).locator('css=#email').fill('');
  await widget(page).locator('css=#title').fill('Cleared email');
  await widget(page).locator('css=#include-screenshot').uncheck();
  await widget(page).locator('css=#submit-btn').click();
  await expect(widget(page).locator('css=.bd-success-icon')).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].submitter).toMatchObject({ name: '<Mira & Co>' });
  expect(Object.hasOwn(requests[0].submitter as object, 'email')).toBe(false);
  expect(JSON.stringify(requests[0])).not.toContain('mira@example.com');
});

for (const email of ['a@bad/domain', 'a@a..b']) {
  test(`Chromium rejects malformed host email ${email} and the form ignores its prefill`, async ({
    page,
  }) => {
    await prepare(page, 'fixed');
    await page.goto('/test/?showEmail=true&prefillProvider=getPrefill');
    await page.waitForFunction(() => Boolean(window.BugDrop));
    const browserRejects = await page.evaluate(value => {
      const input = document.createElement('input');
      input.type = 'email';
      input.value = value;
      return input.validity.typeMismatch;
    }, email);
    expect(browserRejects).toBe(true);
    await page.evaluate(value => {
      (window as unknown as Record<string, unknown>).getPrefill = () => ({ email: value });
      window.BugDrop?.open();
    }, email);
    await expect(widget(page).locator('css=#email')).toHaveValue('');
  });
}

for (const [locale, disclosure] of [
  ['en', 'This email will be included'],
  ['de', 'Diese E-Mail-Adresse wird'],
  ['nl', 'Dit e-mailadres komt'],
  ['pl', 'Ten adres e-mail zostanie'],
] as const) {
  test(`${locale} shows a localized prefilled-email disclosure`, async ({ page }) => {
    await prepare(page, 'fixed');
    await page.goto(`/test/?showEmail=true&prefillProvider=getPrefill&locale=${locale}`);
    await page.waitForFunction(() => Boolean(window.BugDrop));
    await page.evaluate(() => window.BugDrop?.open());
    await expect(widget(page).locator('css=#bd-prefilled-email-disclosure')).toContainText(
      disclosure
    );
  });
}

test('hidden fields stay hidden and a broken provider opens an empty form', async ({ page }) => {
  await prepare(page, 'fixed');
  await page.goto('/test/?prefillProvider=getPrefill');
  await page.waitForFunction(() => Boolean(window.BugDrop));
  await page.evaluate(() => window.BugDrop?.open());
  await expect(widget(page).locator('css=#description')).toHaveValue('<bug & literal>');
  await expect(widget(page).locator('css=#name')).toHaveCount(0);
  await expect(widget(page).locator('css=#email')).toHaveCount(0);
  await page.evaluate(() => window.BugDrop?.close());
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).getPrefill = () => {
      throw new Error('private email');
    };
    window.BugDrop?.open();
  });
  await expect(widget(page).locator('css=#description')).toHaveValue('');
});
