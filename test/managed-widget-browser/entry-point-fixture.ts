import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Page, type Route } from '@playwright/test';

const appOrigin = 'https://fixture-app.localhost';
const widgetOrigin = 'https://managed-widget.localhost';
export const submissionUrl = `${widgetOrigin}/v1/submissions`;
export const applicationId = 'app_managed_browser_fixture';
export const corsHeaders = { 'Access-Control-Allow-Origin': appOrigin };

export const entryPoints = ['script tag', 'packed SDK'] as const;
type Binding = { submissionId: string; payloadDigest: string };
type Controller = {
  open(): void | Promise<void>;
  close(): void | Promise<void>;
};
export type FixtureWindow = Window & {
  BugDrop?: Controller;
  PackedBugDrop: { init(options: Record<string, unknown>): Controller & { ready: Promise<void> } };
  managedFixtureToken?: (binding: Binding) => Promise<string>;
  controller: Controller;
  bindings: Binding[];
};

export async function setupEntryPoint(
  page: Page,
  entryPoint: (typeof entryPoints)[number],
  submit: (route: Route) => Promise<void>,
  {
    button = true,
    providerDelayMs = 0,
    failAuthorizationCalls = [],
    pendingAuthorization = false,
    theme = 'dark',
    accentColor,
  }: {
    button?: boolean;
    providerDelayMs?: number;
    failAuthorizationCalls?: number[];
    pendingAuthorization?: boolean;
    theme?: 'light' | 'dark';
    accentColor?: string;
  } = {}
) {
  const widget = await readFile('dist/managed-widget/widget.managed.v1.js');
  const digest = createHash('sha256').update(widget).digest('hex');
  const widgetUrl = `${widgetOrigin}/widget.managed.${digest}.js`;
  let widgetRequests = 0;
  await page.route('**/*', async route => {
    const request = route.request();
    const url = request.url();
    if (url === `${appOrigin}/` && request.isNavigationRequest()) {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><button id="host">Host app</button>',
      });
    }
    if (url === widgetUrl && request.resourceType() === 'script') {
      widgetRequests++;
      return route.fulfill({ contentType: 'application/javascript', body: widget });
    }
    if (url === submissionUrl && request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          ...corsHeaders,
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-BugDrop-Submission-Id',
        },
      });
    }
    if (url === submissionUrl && request.method() === 'POST') {
      return submit(route);
    }
    await route.abort();
    throw new Error(`Unexpected ${request.method()} request in the managed widget fixture: ${url}`);
  });
  const sdk =
    entryPoint === 'packed SDK' && (await readFile('dist/managed-widget/packed-sdk.js', 'utf8'));
  await page.goto(appOrigin);
  const boot = async () => {
    const previousWidgetRequests = widgetRequests;
    if (sdk) await page.addScriptTag({ content: sdk });
    const widgetResponse = page.waitForResponse(response => response.url() === widgetUrl);
    const initialize = page.evaluate(
      async ({
        entryPoint,
        applicationId,
        widgetUrl,
        button,
        providerDelayMs,
        failAuthorizationCalls,
        pendingAuthorization,
        theme,
        accentColor,
      }) => {
        const fixture = window as unknown as FixtureWindow;
        fixture.bindings = [];
        const tokenProvider = async (binding: Binding) => {
          fixture.bindings.push({ ...binding });
          const call = fixture.bindings.length;
          if (failAuthorizationCalls.includes(call))
            throw new Error('Synthetic authorization failure');
          if (pendingAuthorization) return new Promise<never>(() => {});
          if (providerDelayMs) await new Promise(resolve => setTimeout(resolve, providerDelayMs));
          return {
            schemaVersion: 1,
            token: `fixture-token-${call}+/=`,
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
          };
        };
        const position = 'bottom-left';
        const presentation = accentColor ? { accentColor } : undefined;
        if (entryPoint === 'packed SDK') {
          const controller = fixture.PackedBugDrop.init({
            applicationId,
            widgetUrl,
            button,
            theme,
            position,
            tokenProvider,
            ...(presentation ? { presentation } : {}),
          });
          await controller.ready;
          fixture.controller = controller;
          return;
        }

        fixture.managedFixtureToken = async binding => (await tokenProvider(binding)).token;
        const script = document.createElement('script');
        script.src = widgetUrl;
        Object.assign(script.dataset, {
          applicationId,
          theme,
          position,
          button: String(button),
          authTokenProvider: 'managedFixtureToken',
          contractVersion: '1',
        });
        if (presentation) {
          const request = JSON.stringify({ version: 1, options: presentation });
          script.dataset.presentation = request;
          script.addEventListener('bugdrop:presentation-ready', event => {
            if ((event as CustomEvent).detail === request) event.preventDefault();
          });
        }
        await new Promise<void>((resolve, reject) => {
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('The managed script did not load'));
          document.head.append(script);
        });
        if (!fixture.BugDrop) throw new Error('The managed script did not initialize');
        fixture.controller = fixture.BugDrop;
      },
      {
        entryPoint,
        applicationId,
        widgetUrl,
        button,
        providerDelayMs,
        failAuthorizationCalls,
        pendingAuthorization,
        theme,
        accentColor,
      }
    );

    const [response] = await Promise.all([widgetResponse, initialize]);
    expect(widgetRequests - previousWidgetRequests).toBe(1);
    expect(response.ok()).toBe(true);
    expect(
      createHash('sha256')
        .update(await response.body())
        .digest('hex')
    ).toBe(digest);
    const script = page.locator(`script[src="${widgetUrl}"]`);
    await expect(script).toHaveCount(1);
    if (entryPoint === 'script tag') await expect(script).not.toHaveAttribute('data-sdk-version');
  };
  await boot();
  return { boot, host: page.locator('#bugdrop-managed-host') };
}
