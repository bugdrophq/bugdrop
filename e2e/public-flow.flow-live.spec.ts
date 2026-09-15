import { expect, type Page } from '@playwright/test';
import { flowRecipes, type FlowRecipeId } from '../test/fixtures/flow-recipes';
import {
  assertExactPreviewWidgetResponse,
  test,
  waitForPreviewWidgetResponse,
} from './live-preview-widget';

type Payload = Record<string, unknown> & {
  title: string;
  description: string;
  category: string;
  screenshot: string | null;
  attachments: Array<Record<string, unknown>>;
};

const expectedWidgetOrigin = process.env.EXPECTED_WIDGET_ORIGIN;
const expectedWidgetSha256 = process.env.EXPECTED_WIDGET_SHA256;
const venuePath = process.env.LIVE_VENUE_PATH || '/';
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

if (bypassSecret) {
  test.beforeEach(async ({ context }) => {
    await context.route('**/*.vercel.app/**', route =>
      route.continue({
        headers: {
          ...route.request().headers(),
          'x-vercel-protection-bypass': bypassSecret,
        },
      })
    );
  });
}

async function loadExactFlowWidget(page: Page): Promise<void> {
  if (!expectedWidgetOrigin || !expectedWidgetSha256) {
    throw new Error('Composable preview journeys require exact candidate origin and SHA-256');
  }
  const response = waitForPreviewWidgetResponse(page, expectedWidgetOrigin);
  await page.goto(venuePath);
  await expect
    .poll(() => page.evaluate(() => typeof window.BugDrop?.registerFlow))
    .toBe('function');
  await assertExactPreviewWidgetResponse(await response, expectedWidgetSha256);
}

async function prepareJourney(page: Page, issueNumber: number): Promise<Payload[]> {
  await page.route('**/api/check/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ installed: true, appName: 'neonwatty-bugdrop' }),
    })
  );
  const payloads: Payload[] = [];
  await page.route('**/api/feedback', route => {
    payloads.push(route.request().postDataJSON() as Payload);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        issueNumber,
        issueUrl: `https://github.com/bugdrophq/bugdrop-widget-test/issues/${issueNumber}`,
        isPublic: false,
      }),
    });
  });
  await loadExactFlowWidget(page);
  return payloads;
}

async function openRecipe(page: Page, id: FlowRecipeId) {
  const recipe = flowRecipes[id];
  await page.evaluate(
    ({ config, openOptions }) => window.BugDrop!.registerFlow(config).open(openOptions),
    { config: recipe.config, openOptions: recipe.openOptions }
  );
  return page.locator(`body > [data-bugdrop-flow="${recipe.config.id}"]`);
}

function expectValidPngDataUrl(value: unknown): void {
  expect(value).toEqual(expect.stringMatching(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/));
  const bytes = Buffer.from((value as string).split(',')[1]!, 'base64');
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

test('Bug Report completes its exact candidate preview journey', async ({ page }) => {
  const payloads = await prepareJourney(page, 951);
  await page.evaluate(() => console.info('preview-bug-report-log'));
  const host = await openRecipe(page, 'bug-report');

  await expect(host.getByRole('heading', { name: 'Report a problem' })).toBeVisible();
  await host.getByRole('button', { name: 'Start report' }).click();
  await host.getByLabel('Summary').fill('Preview save crashes');
  await host.getByLabel('Steps to reproduce').fill('Open settings\nClick save');
  await host.getByRole('button', { name: 'Add evidence' }).click();
  await host.getByLabel('Attachments').setInputFiles({
    name: 'preview-trace.png',
    mimeType: 'image/png',
    buffer: Buffer.from('preview trace'),
  });
  await host.getByLabel('Your name').fill('Ada');
  await host.getByLabel('Email').fill('ada@example.com');
  await host.getByRole('button', { name: 'Continue' }).click();
  await expect(host.getByRole('heading', { name: 'Show us the problem' })).toBeVisible();
  await expect(host.getByLabel('Include a screenshot')).toHaveCount(0);
  await host.getByRole('button', { name: 'Submit' }).click();

  const capture = page.locator('#bugdrop-host');
  await expect(capture.getByRole('heading', { name: 'Capture Screenshot' })).toBeVisible();
  await expect(capture.getByRole('button', { name: /skip screenshot/i })).toHaveCount(0);
  await capture.locator('[data-action="capture"]').focus();
  await page.keyboard.press('Enter');
  await expect(capture.locator('#annotation-canvas canvas')).toBeVisible();
  await capture.locator('[data-action="done"]').focus();
  await page.keyboard.press('Enter');
  await expect(host.getByRole('heading', { name: 'Report received' })).toBeVisible();

  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({
    title: 'Bug: Preview save crashes',
    category: 'bug',
    submitter: { name: 'Ada', email: 'ada@example.com' },
    attachments: [expect.objectContaining({ name: 'preview-trace.png', type: 'image/png' })],
  });
  expect(payloads[0]?.description).toContain('> Open settings\n> Click save');
  expectValidPngDataUrl(payloads[0]?.screenshot);
});

test('Product Triage completes its exact candidate preview journey', async ({ page }) => {
  const payloads = await prepareJourney(page, 952);
  const host = await openRecipe(page, 'product-triage');

  await host.getByRole('button', { name: 'Continue' }).click();
  await host.getByLabel('Bug').click();
  await host.getByRole('radio', { name: '2 stars' }).click();
  await host.getByLabel('Summary').fill('Preview checkout stalls');
  await host.getByRole('button', { name: 'Continue' }).click();
  await host.getByLabel('What happened?').fill('Spinner never stops');
  await host.getByLabel('Chromium').click();
  await host.getByRole('button', { name: 'Continue' }).click();
  await host.getByRole('button', { name: 'Back' }).click();
  await expect(host.getByLabel('What happened?')).toHaveValue('Spinner never stops');
  await expect(host.getByLabel('Chromium')).toBeChecked();
  await host.getByRole('button', { name: 'Back' }).click();
  await host.getByRole('radio', { name: '4 stars' }).click();
  await host.getByRole('button', { name: 'Continue' }).click();
  await host.getByLabel('Include a screenshot').uncheck();
  await host.getByRole('button', { name: 'Submit' }).click();
  await expect(host.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();

  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({
    title: 'Triage: Preview checkout stalls',
    category: 'feature',
    screenshot: null,
    attachments: [],
    description: '## Type\n\nBug\n\n## Experience\n\n★★★★☆ (4/5)',
  });
  expect(payloads[0]?.description).not.toContain('Spinner never stops');
});

test('Customer Pulse completes its exact candidate preview journey', async ({ page }) => {
  const payloads = await prepareJourney(page, 953);
  const host = await openRecipe(page, 'customer-pulse');

  await host.getByRole('radio', { name: '3 stars' }).click();
  await host.getByRole('button', { name: 'Continue' }).click();
  await host.getByLabel('What made this difficult?').fill('Invoice filters reset');
  await host.getByLabel('Yes').click();
  await host.getByLabel('I consent to a product follow-up').check();
  await host.getByRole('button', { name: 'Send pulse' }).click();
  await expect(host.getByRole('heading', { name: 'Pulse recorded' })).toBeVisible();
  await expect(host.getByText('Thanks for sharing how billing feels today.')).toBeVisible();

  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({
    title: 'Billing pulse 3/10',
    category: 'question',
    screenshot: null,
    attachments: [],
    description:
      '## Score\n\n3\n\n## Follow-up\n\nInvoice filters reset\n\n## Contact\n\nYes\n\n## Consent\n\ntrue',
  });
});
