import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const app = 'https://bugdrop.localhost';
const accent = '#a1236f';
const accentRgb = 'rgb(161, 35, 111)';
const candidate = process.env.BUGDROP_MANAGED_PRESENTATION === '1';
const baseline = process.env.BUGDROP_MANAGED_BASELINE_DIR;
type Theme = 'light' | 'dark';
type InitOptions = {
  applicationId: string;
  widgetUrl: string;
  theme?: Theme;
  presentation?: Record<string, unknown>;
};
type Controller = { ready: Promise<void>; open(): Promise<void> };
type FixtureWindow = Window & {
  BugDrop?: { open(): void };
  PackedBugDrop: { init(options: object): Controller };
  PackedBugDropOptIn: { init(options: object): Controller };
};

async function fixture(page: Page, packedSdk = 'dist/managed-widget/packed-sdk.js') {
  const widget = await readFile('dist/managed-widget/widget.managed.v1.js', 'utf8');
  const classic = await readFile('public/widget.js', 'utf8');
  const sdk = await readFile(packedSdk, 'utf8');
  const olderWidget = baseline && (await readFile(`${baseline}/widget.managed.v1.js`, 'utf8'));
  await page.route('**/*', async route => {
    const request = new URL(route.request().url());
    if (request.origin !== app) return route.abort();
    if (request.pathname === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><button id="host">Host app</button>',
      });
    }
    if (request.pathname === '/classic.js' || request.pathname === '/managed.js') {
      return route.fulfill({
        contentType: 'application/javascript',
        body: request.pathname === '/classic.js' ? classic : widget,
      });
    }
    if (request.pathname === '/older.js' && olderWidget) {
      return route.fulfill({ contentType: 'application/javascript', body: olderWidget });
    }
    if (request.pathname.startsWith('/api/check/')) {
      return route.fulfill({ json: { installed: true, appName: 'Fixture', isPublic: false } });
    }
    return route.abort();
  });
  await page.goto(app);
  await page.addScriptTag({ content: sdk });
}

async function startManaged(page: Page, options: Partial<InitOptions> = {}, optIn = false) {
  await page.evaluate(
    async ({ app, options, optIn }) => {
      const fixture = window as unknown as FixtureWindow;
      const sdk = optIn ? fixture.PackedBugDropOptIn : fixture.PackedBugDrop;
      const tokenProvider = () => {
        throw new Error('Appearance must not request a report capability');
      };
      const controller = sdk.init({
        applicationId: 'app_presentation_fixture',
        widgetUrl: `${app}/managed.js`,
        ...options,
        ...(optIn ? { tokenProviderWithMetadata: tokenProvider } : { tokenProvider }),
      });
      await controller.ready;
    },
    { app, options, optIn }
  );
}

for (const theme of ['light', 'dark'] as const) {
  test(`script tag and SDK render the same accent in ${theme} mode`, async ({ page }) => {
    test.skip(!candidate, 'Requires a packed SDK with the presentation contract');
    await fixture(page);
    await page.evaluate(
      async ({ accent, theme }) => {
        const script = document.createElement('script');
        script.src = '/classic.js';
        Object.assign(script.dataset, {
          repo: 'example/fixture',
          apiUrl: location.origin + '/api',
          color: accent,
          theme,
        });
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = reject;
          document.head.append(script);
        });
      },
      { accent, theme }
    );
    await expect(page.locator('#bugdrop-host .bd-trigger')).toHaveCSS(
      'background-color',
      accentRgb
    );

    await page.reload();
    const sdk = await readFile('dist/managed-widget/packed-sdk.js', 'utf8');
    await page.addScriptTag({ content: sdk });
    await startManaged(page, { theme, presentation: { accentColor: accent } }, theme === 'dark');
    const managed = page.locator('#bugdrop-managed-host');
    const launcher = managed.locator('.launcher');
    await expect(launcher).toHaveCSS('background-color', accentRgb);
    await launcher.click();
    await page.keyboard.press('Tab');
    await expect(managed.locator('textarea')).toHaveCSS('outline-color', accentRgb);
    await expect(managed.locator('.primary')).toHaveCSS('background-color', accentRgb);
    await page.keyboard.press('Escape');
    await expect(launcher).toBeFocused();
  });
}

test('build only mounts valid presentation after a script-scoped acknowledgment', async ({
  page,
}) => {
  await page.addInitScript(() => {
    CanvasRenderingContext2D.prototype.getImageData = () => {
      throw new Error('Canvas pixel readback is unavailable');
    };
  });
  await fixture(page);
  const mount = (options: object, acknowledge: boolean) =>
    page.evaluate(
      async ({ options, acknowledge }) => {
        const script = document.createElement('script');
        script.src = '/managed.js';
        const request = JSON.stringify({ version: 1, options });
        Object.assign(script.dataset, {
          contractVersion: '1',
          applicationId: 'app_presentation_fixture',
          authTokenProvider: 'fixturePresentationProvider',
          presentation: request,
        });
        Object.assign(window, {
          fixturePresentationProvider: () => {
            throw new Error('Unexpected authorization');
          },
        });
        if (acknowledge) {
          script.addEventListener('bugdrop:presentation-ready', event => {
            if ((event as CustomEvent).detail === request) event.preventDefault();
          });
        }
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = reject;
          document.head.append(script);
        });
        script.remove();
      },
      { options, acknowledge }
    );

  await mount({ accentColor: '#fafafa' }, false);
  await expect(page.locator('#bugdrop-managed-host')).toHaveCount(0);
  await mount({ accentColor: 'red; background: blue' }, true);
  await expect(page.locator('#bugdrop-managed-host')).toHaveCount(0);
  await mount({ accentColor: 'initial' }, true);
  await expect(page.locator('#bugdrop-managed-host')).toHaveCount(0);
  await mount({ accentColor: 'var(--fixture-unset-accent)' }, true);
  await expect(page.locator('#bugdrop-managed-host')).toHaveCount(0);
  await mount({ accentColor: '#fafafa', repo: 'example/other' }, true);
  await expect(page.locator('#bugdrop-managed-host')).toHaveCount(0);
  await page.locator('body').evaluate(body => (body.style.color = '#000'));
  await mount({ accentColor: 'color-mix(in srgb, currentColor 99%, white)' }, true);
  await expect(page.locator('#bugdrop-managed-host .launcher')).toHaveCSS(
    'background-color',
    'rgb(3, 3, 3)'
  );
  await expect(page.locator('#bugdrop-managed-host .launcher')).toHaveCSS(
    'color',
    'rgb(255, 255, 255)'
  );

  await page.reload();
  await mount({ accentColor: 'rgb(none 100 0 / none)' }, true);
  await expect(page.locator('#bugdrop-managed-host')).toHaveCount(0);
  await mount({ accentColor: 'rgb(none 100 0 / 1)' }, true);
  await expect(page.locator('#bugdrop-managed-host .launcher')).toHaveCSS(
    'background-color',
    'rgb(0, 100, 0)'
  );

  await page.reload();
  await page
    .locator('html')
    .evaluate(root => root.style.setProperty('--fixture-accent', '#fafafa'));
  await mount({ accentColor: 'var(--fixture-accent)' }, true);
  const launcher = page.locator('#bugdrop-managed-host .launcher');
  await expect(launcher).toHaveCSS('background-color', 'rgb(250, 250, 250)');
  await expect(launcher).toHaveCSS('color', 'rgb(0, 0, 0)');
  await launcher.click();
  await expect(page.locator('#bugdrop-managed-host .primary')).toHaveCSS('color', 'rgb(0, 0, 0)');
  await page.keyboard.press('Tab');
  const textarea = page.locator('#bugdrop-managed-host textarea');
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveCSS(
    'box-shadow',
    'rgb(255, 255, 255) 0px 0px 0px 2px, rgb(0, 0, 0) 0px 0px 0px 4px'
  );
});

test('older SDK boots the managed widget with its existing defaults', async ({ page }) => {
  const olderSdk = baseline ? `${baseline}/packed-sdk.js` : undefined;
  test.skip(candidate && !olderSdk, 'This candidate run has no older SDK artifact');
  await fixture(page, olderSdk);
  await page.locator('html').evaluate(root => root.style.setProperty('--bd-primary', 'red'));
  await startManaged(page, { theme: 'dark' });
  const managed = page.locator('#bugdrop-managed-host');
  await expect(managed.locator('.launcher')).toHaveCSS('background-color', 'rgb(23, 105, 170)');
  await managed.locator('.launcher').click();
  await expect(managed.locator('.primary')).toHaveCSS('background-color', 'rgb(23, 105, 170)');
});

test('candidate rejects older widget without residue and can retry with the supported one', async ({
  page,
}) => {
  test.skip(!candidate || !baseline, 'Requires candidate SDK and an older managed widget artifact');
  await fixture(page);
  await expect(
    startManaged(page, {
      widgetUrl: `${app}/older.js`,
      presentation: { accentColor: accent },
    })
  ).rejects.toThrow('does not support the requested presentation configuration');
  await expect(page.locator('#bugdrop-managed-host, script[data-presentation]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).BugDrop)).toBeUndefined();

  await startManaged(page, { presentation: { accentColor: accent } });
  await startManaged(page, { presentation: { accentColor: accent } });
  await expect(startManaged(page, { presentation: { accentColor: '#080808' } })).rejects.toThrow(
    'different presentation configuration'
  );
  await expect(page.locator('#bugdrop-managed-host')).toHaveCount(1);
  await expect(page.locator('#bugdrop-managed-host .launcher')).toHaveCSS(
    'background-color',
    accentRgb
  );
});

test('candidate SDK loads an older managed widget when presentation is omitted', async ({
  page,
}) => {
  test.skip(!candidate || !baseline, 'Requires candidate SDK and an older managed widget artifact');
  await fixture(page);
  await startManaged(page, { widgetUrl: `${app}/older.js` });
  await expect(page.locator('#bugdrop-managed-host .launcher')).toBeVisible();
  await expect(page.locator('script[data-presentation]')).toHaveCount(0);
});
