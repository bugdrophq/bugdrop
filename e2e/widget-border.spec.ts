import { expect, test, type Locator, type Page } from '@playwright/test';

const DEFAULT_BORDER_COLOR = 'rgb(231, 229, 228)';

type BorderSnapshot = {
  color: string;
  style: string;
  width: string;
};

type FormBorderSnapshot = {
  input: BorderSnapshot;
  modal: BorderSnapshot;
};

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

async function mountWidget(
  page: Page,
  baseURL: string | undefined,
  dataset: Record<string, string> = {}
): Promise<void> {
  await page.route('**/api/check/**', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ installed: true }),
    });
  });

  const widgetUrl = new URL('/widget.js', baseURL ?? 'http://localhost:8787').toString();
  const dataAttributes = Object.entries(dataset)
    .map(([key, value]) => `data-${key}="${escapeAttribute(value)}"`)
    .join(' ');

  await page.setContent(`
    <!doctype html>
    <html>
      <body>
        <script
          id="bugdrop-script"
          src="${widgetUrl}"
          data-repo="mean-weasel/bugdrop-widget-test"
          data-theme="light"
          data-welcome="never"
          ${dataAttributes}
        ></script>
      </body>
    </html>
  `);

  await page.locator('#bugdrop-host').locator('css=.bd-trigger').waitFor({ state: 'visible' });
}

async function readBorder(locator: Locator): Promise<BorderSnapshot> {
  return locator.evaluate(element => {
    const styles = getComputedStyle(element);
    return {
      color: styles.borderTopColor,
      style: styles.borderTopStyle,
      width: styles.borderTopWidth,
    };
  });
}

async function openFormAndReadBorders(
  page: Page,
  expectedInputColor: string
): Promise<FormBorderSnapshot> {
  const host = page.locator('#bugdrop-host');
  await host.locator('css=.bd-trigger').click();

  const modal = host.locator('css=.bd-modal');
  const titleInput = host.locator('css=#title');
  await expect(modal).toBeVisible();
  await expect(titleInput).toBeVisible();
  // The accessible dialog intentionally focuses the title on open. Measure
  // the theme border after moving focus away and its transition has settled.
  await modal.focus();
  await expect(titleInput).not.toBeFocused();
  await expect(titleInput).toHaveCSS('border-top-color', expectedInputColor);

  return {
    input: await readBorder(titleInput),
    modal: await readBorder(modal),
  };
}

test.describe('widget border styles', () => {
  test('renders default form borders from theme variables', async ({ page, baseURL }) => {
    await mountWidget(page, baseURL);

    const expectedBorder = {
      color: DEFAULT_BORDER_COLOR,
      style: 'solid',
      width: '1px',
    };

    await expect(openFormAndReadBorders(page, expectedBorder.color)).resolves.toEqual({
      input: expectedBorder,
      modal: expectedBorder,
    });
  });

  test('keeps the theme border color when only border width is customized', async ({
    page,
    baseURL,
  }) => {
    await mountWidget(page, baseURL, { 'border-width': '4' });

    const expectedBorder = {
      color: DEFAULT_BORDER_COLOR,
      style: 'solid',
      width: '4px',
    };

    await expect(openFormAndReadBorders(page, expectedBorder.color)).resolves.toEqual({
      input: expectedBorder,
      modal: expectedBorder,
    });
  });

  test('uses explicit custom border color with custom border width', async ({ page, baseURL }) => {
    await mountWidget(page, baseURL, {
      'border-color': '#64748b',
      'border-width': '2',
    });

    const expectedBorder = {
      color: 'rgb(100, 116, 139)',
      style: 'solid',
      width: '2px',
    };

    await expect(openFormAndReadBorders(page, expectedBorder.color)).resolves.toEqual({
      input: expectedBorder,
      modal: expectedBorder,
    });
  });
});
