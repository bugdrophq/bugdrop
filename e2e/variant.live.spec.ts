import { expect, type Page, type Request } from '@playwright/test';
import {
  assertExactPreviewWidgetResponse,
  test,
  waitForPreviewWidgetResponse,
} from './live-preview-widget';

const expectedWidgetOrigin = process.env.EXPECTED_WIDGET_ORIGIN;
const expectedWidgetSha256 = process.env.EXPECTED_WIDGET_SHA256;
const venuePath = process.env.LIVE_VENUE_PATH || (process.env.LIVE_TARGET ? '/' : '/test/');

if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
  test.beforeEach(async ({ context }) => {
    await context.route('**/*.vercel.app/**', route =>
      route.continue({
        headers: {
          ...route.request().headers(),
          'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET!,
        },
      })
    );
  });
}

async function loadExactWidget(page: Page) {
  const widgetResponse = expectedWidgetOrigin
    ? waitForPreviewWidgetResponse(page, expectedWidgetOrigin)
    : undefined;
  await page.goto(venuePath);
  await expect
    .poll(() => page.evaluate(() => typeof window.BugDrop?.registerVariant))
    .toBe('function');
  if (widgetResponse && expectedWidgetSha256) {
    await assertExactPreviewWidgetResponse(await widgetResponse, expectedWidgetSha256);
  }
}

async function interceptOneSubmission(page: Page) {
  const submissions: Request[] = [];
  await page.route('**/feedback', route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const requestUrl = new URL(request.url());
    expect(requestUrl.pathname).toBe('/api/feedback');
    if (expectedWidgetOrigin) expect(requestUrl.origin).toBe(expectedWidgetOrigin);
    submissions.push(request);
    if (submissions.length > 1) return route.abort('blockedbyclient');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        issueNumber: 901,
        issueUrl: 'https://github.com/bugdrophq/bugdrop-widget-test/issues/901',
        isPublic: false,
      }),
    });
  });
  return submissions;
}

test.describe('rendered variants on the deployed widget', () => {
  test('renders and submits the exact inline star-review draft', async ({ page }) => {
    const submissions = await interceptOneSubmission(page);
    await loadExactWidget(page);
    await page.evaluate(() => {
      const slot = document.createElement('div');
      slot.id = 'live-review-slot';
      document.body.appendChild(slot);
      window
        .BugDrop!.registerVariant({
          id: 'live-export-review',
          presentation: { kind: 'inline' },
          content: { title: 'How was this export?', submitLabel: 'Submit review' },
          fields: [
            { id: 'rating', type: 'rating', label: 'Rating', required: true, scale: 5 },
            { id: 'message', type: 'longText', label: 'Anything else?', maxLength: 1000 },
          ],
          issue: {
            classification: 'feedback',
            title: '[Live export review] {{rating}}/5',
            sections: [
              { heading: 'Rating', field: 'rating', format: 'stars' },
              { heading: 'Comment', field: 'message', omitWhenEmpty: true },
            ],
          },
        })
        .mount(slot);
    });
    const host = page.locator('#live-review-slot > [data-bugdrop-owned]');
    await host.getByRole('radio', { name: '4 stars' }).click();
    await host.getByRole('textbox', { name: 'Anything else?' }).fill('Exact preview review');
    expect(submissions).toHaveLength(0);
    await host.getByRole('button', { name: 'Submit review' }).click();
    await expect(host.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
    expect(submissions).toHaveLength(1);
    expect(submissions[0].postDataJSON()).toMatchObject({
      kind: 'bugdrop.variant-submission',
      schemaVersion: 1,
      variantId: 'live-export-review',
      issue: {
        title: '[Live export review] 4/5',
        classification: 'feedback',
        sections: [
          { heading: 'Rating', value: '★★★★☆ (4/5)', format: 'text' },
          { heading: 'Comment', value: 'Exact preview review', format: 'text' },
        ],
      },
    });
  });

  test('opens and submits the exact CTA text-modal draft', async ({ page }) => {
    const submissions = await interceptOneSubmission(page);
    await loadExactWidget(page);
    await page.evaluate(() => {
      const cta = document.createElement('button');
      cta.id = 'live-provider-cta';
      cta.textContent = 'Request a provider';
      document.body.appendChild(cta);
      const handle = window.BugDrop!.registerVariant({
        id: 'live-provider-question',
        presentation: { kind: 'modal', size: 'compact' },
        content: {
          title: 'Which cloud provider should we support next?',
          submitLabel: 'Send idea',
        },
        fields: [
          {
            id: 'response',
            type: 'longText',
            label: 'Your answer',
            required: true,
            minLength: 2,
          },
        ],
        issue: {
          classification: 'feature',
          title: 'Live provider request — {{response}}',
          sections: [{ heading: 'Requested provider', field: 'response' }],
        },
      });
      cta.addEventListener('click', () => handle.open());
      cta.click();
    });
    const host = page.locator('body > [data-bugdrop-owned]');
    await expect(
      host.getByRole('dialog', { name: 'Which cloud provider should we support next?' })
    ).toBeVisible();
    await host.getByRole('textbox', { name: 'Your answer' }).fill('OpenStack');
    expect(submissions).toHaveLength(0);
    await host.getByRole('button', { name: 'Send idea' }).click();
    await expect(host.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
    expect(submissions).toHaveLength(1);
    expect(submissions[0].postDataJSON()).toMatchObject({
      kind: 'bugdrop.variant-submission',
      schemaVersion: 1,
      variantId: 'live-provider-question',
      issue: {
        title: 'Live provider request — OpenStack',
        classification: 'feature',
        sections: [{ heading: 'Requested provider', value: 'OpenStack', format: 'text' }],
      },
    });
  });

  test('renders and submits the exact inline poll draft from pinned bytes', async ({ page }) => {
    const submissions = await interceptOneSubmission(page);
    await loadExactWidget(page);
    await page.evaluate(() => {
      const slot = document.createElement('div');
      slot.id = 'live-poll-slot';
      document.body.appendChild(slot);
      window
        .BugDrop!.registerVariant({
          id: 'live-next-integration-poll',
          presentation: { kind: 'inline' },
          content: { title: 'What should we build next?', submitLabel: 'Vote' },
          fields: [
            {
              id: 'choice',
              type: 'singleChoice',
              label: 'Choose one',
              required: true,
              display: 'cards',
              options: [
                { value: 'onedrive', label: 'OneDrive' },
                { value: 'box', label: 'Box' },
              ],
            },
            { id: 'detail', type: 'longText', label: 'Optional detail', maxLength: 500 },
          ],
          issue: {
            classification: 'feature',
            title: 'Integration vote — {{choice}}',
            sections: [
              { heading: 'Choice', field: 'choice', format: 'choice' },
              { heading: 'Detail', field: 'detail', omitWhenEmpty: true },
            ],
          },
        })
        .mount(slot);
    });

    const host = page.locator('#live-poll-slot > [data-bugdrop-owned]');
    await host.getByRole('radio', { name: 'OneDrive' }).click();
    await host.getByRole('textbox', { name: 'Optional detail' }).fill('Exact preview poll');
    expect(submissions).toHaveLength(0);
    await host.getByRole('button', { name: 'Vote' }).click();
    await expect(host.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
    expect(submissions).toHaveLength(1);
    expect(submissions[0].postDataJSON()).toMatchObject({
      kind: 'bugdrop.variant-submission',
      schemaVersion: 1,
      variantId: 'live-next-integration-poll',
      issue: {
        title: 'Integration vote — onedrive',
        classification: 'feature',
        sections: [
          { heading: 'Choice', value: 'OneDrive', format: 'text' },
          { heading: 'Detail', value: 'Exact preview poll', format: 'text' },
        ],
      },
    });
  });

  test('opens and submits the exact compact-suggestion draft from pinned bytes', async ({
    page,
  }) => {
    const submissions = await interceptOneSubmission(page);
    await loadExactWidget(page);
    await page.evaluate(() => {
      window
        .BugDrop!.registerVariant({
          id: 'live-compact-suggestion',
          presentation: { kind: 'modal', size: 'default' },
          content: { title: 'Share an idea', submitLabel: 'Submit idea' },
          fields: [
            { id: 'summary', type: 'shortText', label: 'Idea', required: true, maxLength: 120 },
            {
              id: 'detail',
              type: 'longText',
              label: 'How would this help?',
              maxLength: 2_000,
            },
          ],
          issue: {
            classification: 'feature',
            title: '[Idea] {{summary}}',
            sections: [
              { heading: 'Idea', field: 'summary' },
              { heading: 'Why it would help', field: 'detail', omitWhenEmpty: true },
            ],
          },
        })
        .open();
    });

    const host = page.locator('body > [data-bugdrop-owned]');
    await host.getByRole('textbox', { name: 'Idea' }).fill('Pinned preview suggestion');
    await host
      .getByRole('textbox', { name: 'How would this help?' })
      .fill('It proves the existing primitives compose.');
    expect(submissions).toHaveLength(0);
    await host.getByRole('button', { name: 'Submit idea' }).click();
    await expect(host.getByRole('heading', { name: 'Thanks for your feedback!' })).toBeVisible();
    expect(submissions).toHaveLength(1);
    expect(submissions[0].postDataJSON()).toMatchObject({
      kind: 'bugdrop.variant-submission',
      schemaVersion: 1,
      variantId: 'live-compact-suggestion',
      issue: {
        title: '[Idea] Pinned preview suggestion',
        classification: 'feature',
        sections: [
          { heading: 'Idea', value: 'Pinned preview suggestion', format: 'text' },
          {
            heading: 'Why it would help',
            value: 'It proves the existing primitives compose.',
            format: 'text',
          },
        ],
      },
    });
  });
});
