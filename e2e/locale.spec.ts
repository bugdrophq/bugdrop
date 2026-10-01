import { test, expect, type Page } from '@playwright/test';

// public/test maps query params to widget data attributes; these tests assert
// rendered localized UI through the widget shadow DOM.

const WELCOME_TITLES = {
  de: 'Teilen Sie Ihr Feedback',
  en: 'Share Your Feedback',
  nl: 'Deel uw feedback',
  pl: 'Podziel się opinią',
  zhCN: '分享您的反馈',
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

async function submitWithoutScreenshot(page: Page, locale = 'zh-CN') {
  await openWidget(page, { locale });
  const widget = host(page);
  await widget.locator('css=[data-action="continue"]').click();
  await widget.locator('css=#title').fill('提交失败测试');
  await widget.locator('css=#include-screenshot').uncheck();
  await widget.locator('css=#submit-btn').click();
  await expect(modalTitle(page)).toHaveText(locale === 'en' ? 'Submission Failed' : '提交失败');
  return widget.locator('css=.bd-error-message__text');
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

  test('data-locale selects Simplified Chinese with case and script extensions', async ({
    page,
  }) => {
    await openWidget(page, { locale: 'ZH_hANS_tw' });
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.zhCN);
  });

  test('html lang selects Simplified Chinese when data-locale is absent', async ({ page }) => {
    await openWidget(page, {}, { htmlLang: 'zh-CN' });
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.zhCN);
  });

  test('data-locale takes precedence over a Chinese html lang', async ({ page }) => {
    await openWidget(page, { locale: 'nl' }, { htmlLang: 'zh-CN' });
    await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.nl);
  });

  for (const locale of ['zh', 'zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-CN']) {
    test(`${locale} falls back to English`, async ({ page }) => {
      await openWidget(page, { locale });
      await expect(modalTitle(page)).toHaveText(WELCOME_TITLES.en);
    });
  }

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

  test('localizes trigger text and keeps data-label as a visible-label override', async ({
    page,
  }) => {
    await openWidget(page, { locale: 'pl', label: 'Custom CTA' });

    const trigger = host(page).locator('css=.bd-trigger');
    await expect(trigger.locator('css=.bd-trigger-label')).toHaveText('Custom CTA');
    await expect(trigger).toHaveAttribute('aria-label', 'Zgłoś błąd lub wyślij opinię');
  });

  test('Chinese label override preserves the translated accessible label', async ({ page }) => {
    await openWidget(page, { locale: 'zh-CN', label: '联系支持' });
    const trigger = host(page).locator('css=.bd-trigger');
    await expect(trigger.locator('css=.bd-trigger-label')).toHaveText('联系支持');
    await expect(trigger).toHaveAttribute('aria-label', '报告问题或发送反馈');
  });

  test('renders Chinese validation, screenshot choices, and success', async ({ page }) => {
    await page.route('**/feedback', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, issueNumber: 42, issueUrl: '#', isPublic: false }),
      });
    });
    await openWidget(page, { locale: 'zh-CN' });
    const widget = host(page);
    await widget.locator('css=[data-action="continue"]').click();
    await expect(modalTitle(page)).toHaveText('发送反馈');
    await expect(widget.locator('css=label[for="title"]')).toHaveText('标题 *');
    await expect(widget.locator('css=#title')).toHaveAttribute('required', '');
    await widget.locator('css=.bd-category-option').nth(1).click();
    await expect(widget.locator('css=input[name="category"][value="feature"]')).toBeChecked();
    await widget.locator('css=#submit-btn').click();
    await expect(modalTitle(page)).toHaveText('发送反馈');
    await widget.locator('css=#title').fill('测试中文反馈');
    await widget.locator('css=#submit-btn').click();
    await expect(modalTitle(page)).toHaveText('截图');
    await expect(widget.locator('css=[data-action="capture"]')).toHaveText('整页');
    await expect(widget.locator('css=[data-action="area"]')).toHaveText('选择区域');
    await expect(widget.locator('css=[data-action="element"]')).toHaveText('选择元素');
    await widget.locator('css=[data-action="skip"]').click();
    await expect(modalTitle(page)).toHaveText('反馈已提交！');
    await expect(widget.locator('css=.bd-success-issue')).toHaveText('您的反馈已成功提交。');
  });

  test('Chinese widget fits a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openWidget(page, { locale: 'zh-CN' });
    const widget = host(page);
    await widget.locator('css=[data-action="continue"]').click();
    await expect(modalTitle(page)).toHaveText('发送反馈');
    const modal = widget.locator('css=.bd-modal');
    const box = await modal.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);
    const categoryBounds = await widget.locator('css=.bd-category-option').evaluateAll(options =>
      options.map(option => {
        const label = option.getBoundingClientRect();
        const span = option.querySelector('span')?.getBoundingClientRect();
        if (!span) throw new Error('Category text missing');
        return {
          label: { left: label.left, right: label.right, top: label.top, bottom: label.bottom },
          span: { left: span.left, right: span.right },
        };
      })
    );
    expect(categoryBounds).toHaveLength(3);
    for (const [index, option] of categoryBounds.entries()) {
      expect(option.span.left).toBeGreaterThanOrEqual(option.label.left - 0.5);
      expect(option.span.right).toBeLessThanOrEqual(option.label.right + 0.5);
      for (const next of categoryBounds.slice(index + 1)) {
        if (
          Math.min(option.label.bottom, next.label.bottom) >
          Math.max(option.label.top, next.label.top)
        ) {
          expect(option.label.right).toBeLessThanOrEqual(next.label.left + 0.5);
        }
      }
    }
    for (const [index, category] of ['bug', 'feature', 'question'].entries()) {
      await widget.locator('css=.bd-category-option').nth(index).click();
      await expect(widget.locator(`css=input[name="category"][value="${category}"]`)).toBeChecked();
    }
    await widget.locator('css=#title').fill('窄屏测试');
    await widget.locator('css=#submit-btn').click();
    await expect(modalTitle(page)).toHaveText('截图');
    const optionsBox = await modal.boundingBox();
    expect(optionsBox).not.toBeNull();
    expect(optionsBox!.x + optionsBox!.width).toBeLessThanOrEqual(321);
  });

  test('renders Chinese annotation tools and privacy instruction after capture', async ({
    page,
  }) => {
    await openWidget(page, { locale: 'zh-CN' });
    const widget = host(page);
    await widget.locator('css=[data-action="continue"]').click();
    await widget.locator('css=#title').fill('截图标注测试');
    await widget.locator('css=#submit-btn').click();
    await widget.locator('css=[data-action="capture"]').click();
    await expect(modalTitle(page)).toHaveText('检查截图', { timeout: 15000 });
    await expect(widget.locator('css=#annotation-canvas canvas')).toBeVisible();
    await expect(widget.locator('css=[data-tool="redact"]')).toHaveText('遮盖');
    await expect(widget.locator('css=[data-tool="pan"]')).toContainText('平移');
    await expect(widget.locator('css=[data-view="fit"]')).toHaveText('适应宽度');
    await expect(widget.locator('css=[data-view="in"]')).toHaveAttribute('aria-label', '放大');
    await expect(widget.locator('css=[data-view="out"]')).toHaveAttribute('aria-label', '缩小');
    await expect(widget.locator('css=[data-view="reset"]')).toHaveText('重置视图');
    await expect(widget.locator('css=[data-action="retake"]')).toHaveText('重新截图');
    await expect(widget.locator('css=[data-action="done"]')).toHaveText('提交反馈');
    await expect(widget.locator('css=.bd-modal')).toContainText('遮盖效果会永久保留在上传的图片中');
  });

  test('shows the prefilled-email privacy reminder in Chinese', async ({ page }) => {
    await page.addInitScript(() => {
      (
        window as typeof window & { getChinesePrefill?: () => { email: string } }
      ).getChinesePrefill = () => ({ email: 'reporter@example.com' });
    });
    await page.route('**/test/**', async route => {
      if (new URL(route.request().url()).pathname !== '/test/') return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).replace(
        "showEmail: 'showEmail',",
        "showEmail: 'showEmail', prefillProvider: 'prefillProvider',"
      );
      await route.fulfill({ response, body });
    });
    await openWidget(page, {
      locale: 'zh-CN',
      showEmail: 'true',
      prefillProvider: 'getChinesePrefill',
    });
    const widget = host(page);
    await widget.locator('css=[data-action="continue"]').click();
    await expect(widget.locator('css=#email')).toHaveValue('reporter@example.com');
    await expect(widget.locator('css=#bd-prefilled-email-disclosure')).toHaveText(
      '如果保留此邮箱，提交的 GitHub 问题中会包含它。您可以修改或清空。'
    );
  });

  for (const failure of [
    { status: 400, code: 'INVALID_SUBMITTER', expected: '姓名或电子邮箱无效。请检查后重试。' },
    { status: 400, code: 'INVALID_SCREENSHOT', expected: '截图无效。请重新截图。' },
    {
      status: 401,
      code: 'AUTH_REQUIRED',
      expected: '授权失败。请刷新页面，或联系网站管理员。',
    },
    { status: 403, code: 'APP_NOT_INSTALLED', expected: '此仓库尚未安装 GitHub 应用。' },
    { status: 500, code: 'ISSUE_CREATION_FAILED', expected: '无法创建问题。请稍后重试。' },
  ]) {
    test(`localizes ${failure.code} without exposing server English`, async ({ page }) => {
      await page.route('**/feedback', route =>
        route.fulfill({
          status: failure.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'English backend diagnostic', code: failure.code }),
        })
      );
      const message = await submitWithoutScreenshot(page);
      await expect(message).toHaveText(failure.expected);
      await expect(message).not.toContainText('English backend diagnostic');
    });
  }

  test('unknown API codes use generic Chinese fallback', async ({ page }) => {
    await page.route('**/feedback', route =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'English backend diagnostic', code: 'FUTURE_CODE' }),
      })
    );
    await expect(await submitWithoutScreenshot(page)).toHaveText('提交失败');
  });

  test('older API responses without a code use generic Chinese fallback', async ({ page }) => {
    await page.route('**/feedback', route =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'English backend diagnostic' }),
      })
    );
    const message = await submitWithoutScreenshot(page);
    await expect(message).toHaveText('提交失败');
    await expect(message).not.toContainText('English backend diagnostic');
  });

  test('429 retains the localized retry delay', async ({ page }) => {
    await page.route('**/feedback', route =>
      route.fulfill({
        status: 429,
        headers: { 'Retry-After': '120' },
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many requests' }),
      })
    );
    await expect(await submitWithoutScreenshot(page)).toHaveText(
      '提交过于频繁。请在 2 分钟后重试。'
    );
  });

  test('network failures retain the localized connection message', async ({ page }) => {
    await page.route('**/feedback', route => route.abort('failed'));
    await expect(await submitWithoutScreenshot(page)).toHaveText('网络错误。请检查您的连接。');
  });

  test('English retains the original server diagnostic', async ({ page }) => {
    await page.route('**/feedback', route =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'GitHub API error', code: 'ISSUE_CREATION_FAILED' }),
      })
    );
    await expect(await submitWithoutScreenshot(page, 'en')).toHaveText('GitHub API error');
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
