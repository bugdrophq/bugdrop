import { test, expect, type Page } from '@playwright/test';

// public/test maps query params to widget data attributes; these tests assert
// rendered localized UI through the widget shadow DOM.

const WELCOME_TITLES = {
  de: 'Teilen Sie Ihr Feedback',
  en: 'Share Your Feedback',
  nl: 'Deel uw feedback',
  pl: 'Podziel się opinią',
} as const;

async function openWidget(
  page: Page,
  params: Record<string, string> = {},
  options: { htmlLang?: string } = {}
) {
  await page.route('**/api/check**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ installed: true }),
    });
  });

  const qs = new URLSearchParams({
    ...params,
    ...(options.htmlLang ? { htmlLang: options.htmlLang } : {}),
  }).toString();
  await page.goto(`/test/${qs ? '?' + qs : ''}`);
  // Force the welcome screen so its (translated) title is what opens first.
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
  });

  await expect(page.locator('#bugdrop-host').locator('css=.bd-modal')).toHaveCount(1, {
    timeout: 5000,
  });
}

function modalTitle(page: Page) {
  return page.locator('#bugdrop-host').locator('css=.bd-title');
}

function host(page: Page) {
  return page.locator('#bugdrop-host');
}

test.describe('Widget localization', () => {
  test('defaults to English without data-locale', async ({ page }) => {
    await openWidget(page);
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.en);
  });

  test('data-locale="de" renders the German UI', async ({ page }) => {
    await openWidget(page, { locale: 'de' });
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.de);
  });

  test('data-locale="nl" renders the Dutch UI', async ({ page }) => {
    await openWidget(page, { locale: 'nl' });
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.nl);
  });

  test('data-locale="pl" renders the Polish UI', async ({ page }) => {
    await openWidget(page, { locale: 'pl' });
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.pl);
  });

  test('region subtags resolve to the base language', async ({ page }) => {
    await openWidget(page, { locale: 'nl-NL' });
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.nl);
  });

  test('falls back to html lang when data-locale is absent', async ({ page }) => {
    await openWidget(page, {}, { htmlLang: 'pl-PL' });
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.pl);
  });

  test('data-locale takes precedence over html lang', async ({ page }) => {
    await openWidget(page, { locale: 'nl' }, { htmlLang: 'pl-PL' });
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.nl);
  });

  test('unsupported locale falls back to English and warns', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', msg => {
      const type = msg.type();
      if (type === 'warning' || type === 'warn') {
        warnings.push(msg.text());
      }
    });

    await openWidget(page, { locale: 'xx' });
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.en);
    expect(warnings.some(w => w.includes('[BugDrop] Unsupported data-locale'))).toBe(true);
  });

  test('deferred Chinese locale falls back to English', async ({ page }) => {
    await openWidget(page, { locale: 'zh-CN' });
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.en);
  });

  test('Polish category labels stay inside their options at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openWidget(page, { locale: 'pl' });
    const widget = host(page);
    await widget.locator('css=[data-action="continue"]').click();

    const bounds = await widget.locator('css=.bd-category-option').evaluateAll(options =>
      options.map(option => {
        const label = option.getBoundingClientRect();
        const text = option.querySelector('span')?.getBoundingClientRect();
        if (!text) throw new Error('Category text missing');
        return {
          label: { left: label.left, right: label.right, top: label.top, bottom: label.bottom },
          text: { left: text.left, right: text.right },
        };
      })
    );

    expect(bounds).toHaveLength(3);
    for (const [index, option] of bounds.entries()) {
      expect(option.text.left).toBeGreaterThanOrEqual(option.label.left - 0.5);
      expect(option.text.right).toBeLessThanOrEqual(option.label.right + 0.5);
      for (const next of bounds.slice(index + 1)) {
        if (
          Math.min(option.label.bottom, next.label.bottom) >
          Math.max(option.label.top, next.label.top)
        ) {
          expect(option.label.right).toBeLessThanOrEqual(next.label.left + 0.5);
        }
      }
    }
  });

  test('localizes trigger text and keeps data-label as a visible-label override', async ({
    page,
  }) => {
    await openWidget(page, { locale: 'pl', label: 'Custom CTA' });

    const trigger = host(page).locator('css=.bd-trigger');
    await expect(trigger.locator('css=.bd-trigger-label')).toHaveText('Custom CTA');
    await expect(trigger).toHaveAttribute('aria-label', 'Zgłoś błąd lub wyślij opinię');
  });

  test('renders Polish form and success UI for a no-screenshot submission', async ({ page }) => {
    await page.route('**/feedback', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 42, issueUrl: '#', isPublic: false }),
      });
    });

    await openWidget(page, { locale: 'pl' });
    const widget = host(page);

    await widget.locator('css=[data-action="continue"]').click();
    await expect(modalTitle(page)).toHaveText('Wyślij opinię');
    await expect(widget.locator('css=label[for="title"]')).toHaveText('Tytuł *');
    await expect(widget.locator('css=label[for="description"]')).toHaveText('Opis');
    await expect(widget.locator('css=#include-screenshot + label')).toHaveText(
      '📸 Dołącz zrzut ekranu'
    );

    await widget.locator('css=#title').fill('Test lokalizacji');
    await widget.locator('css=#include-screenshot').uncheck();
    await widget.locator('css=#submit-btn').click();

    await expect(modalTitle(page)).toHaveText('Opinia wysłana!');
    await expect(widget.locator('css=.bd-success-issue')).toHaveText(
      'Twoja opinia została pomyślnie wysłana.'
    );
    await expect(widget.locator('css=[data-action="done"]')).toHaveText('Gotowe');
  });

  test('renders Dutch screenshot choices', async ({ page }) => {
    await openWidget(page, { locale: 'nl' });
    const widget = host(page);

    await widget.locator('css=[data-action="continue"]').click();
    await widget.locator('css=#title').fill('Schermafbeelding testen');
    await widget.locator('css=#include-screenshot').check();
    await widget.locator('css=#submit-btn').click();

    await expect(modalTitle(page)).toHaveText('Schermafbeelding maken');
    await expect(widget.locator('css=[data-action="capture"]')).toHaveText('Volledige pagina');
    await expect(widget.locator('css=[data-action="area"]')).toHaveText('Gebied selecteren');
    await expect(widget.locator('css=[data-action="element"]')).toHaveText('Element selecteren');
    await expect(widget.locator('css=[data-action="skip"]')).toHaveText(
      'Schermafbeelding overslaan'
    );
  });
});
