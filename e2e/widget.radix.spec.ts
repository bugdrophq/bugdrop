import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    BugDrop?: {
      open: () => void;
      isOpen: () => boolean;
    };
    __hostModalOpen?: boolean;
    __hostDismissEvents?: string[];
    __hostFocusTrapEvents?: string[];
    __hostFocusOutTrapEvents?: string[];
  }
}

async function mockInstalledRepo(page: Page): Promise<void> {
  await page.route('**/api/check**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ installed: true }),
    });
  });
}

async function openFeedbackForm(page: Page, viaTrigger = false) {
  const host = page.locator('#bugdrop-host');
  const trigger = host.locator('css=.bd-trigger');
  await expect(trigger).toBeVisible({ timeout: 5000 });
  await expect.poll(() => page.evaluate(() => typeof window.BugDrop?.open)).toBe('function');

  if (viaTrigger) {
    await trigger.evaluate(async element => {
      await Promise.allSettled(element.getAnimations().map(animation => animation.finished));
      // `finished` can resolve before Firefox/WebKit present the final hit-test geometry.
      await new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
    });
    const triggerLabel = trigger.locator('css=.bd-trigger-label');
    await expect(triggerLabel).toBeVisible({ timeout: 5000 });
    await triggerLabel.click();
    await expect.poll(() => page.evaluate(() => window.BugDrop?.isOpen())).toBe(true);
  } else {
    await page.evaluate(() => window.BugDrop?.open());
  }

  await expect(host.locator('css=#title')).toBeVisible({ timeout: 5000 });
  return host;
}

test.describe('Radix dialog compatibility', () => {
  test('widget pointer interactions do not dismiss Radix-style host modals', async ({ page }) => {
    await mockInstalledRepo(page);

    await page.goto('/test/welcome-disabled.html');
    await page.evaluate(() => {
      window.__hostModalOpen = true;
      window.__hostDismissEvents = [];
      document.body.style.pointerEvents = 'none';

      document.addEventListener(
        'pointerdown',
        event => {
          const host = document.getElementById('bugdrop-host');
          if (!host || !event.composedPath().includes(host)) {
            return;
          }

          for (const eventType of [
            'dismissableLayer.pointerDownOutside',
            'dismissableLayer.interactOutside',
          ]) {
            const outsideEvent = new CustomEvent(eventType, {
              bubbles: true,
              cancelable: true,
              composed: true,
              detail: { originalEvent: event },
            });

            window.__hostDismissEvents?.push(eventType);
            document.dispatchEvent(outsideEvent);

            if (!outsideEvent.defaultPrevented) {
              window.__hostModalOpen = false;
            }
          }
        },
        true
      );
    });

    const host = page.locator('#bugdrop-host');
    await expect(host).toHaveCSS('pointer-events', 'auto');
    await openFeedbackForm(page, true);

    await expect.poll(() => page.evaluate(() => window.__hostModalOpen)).toBe(true);
    await expect
      .poll(() => page.evaluate(() => window.__hostDismissEvents))
      .toEqual(['dismissableLayer.pointerDownOutside', 'dismissableLayer.interactOutside']);

    await host.locator('css=#title').click();

    await expect.poll(() => page.evaluate(() => window.__hostModalOpen)).toBe(true);
    await expect
      .poll(() => page.evaluate(() => window.__hostDismissEvents))
      .toEqual([
        'dismissableLayer.pointerDownOutside',
        'dismissableLayer.interactOutside',
        'dismissableLayer.pointerDownOutside',
        'dismissableLayer.interactOutside',
      ]);
  });

  test('widget text fields remain editable inside Radix-style focus traps', async ({ page }) => {
    await mockInstalledRepo(page);

    await page.goto('/test/welcome-disabled.html');
    await page.evaluate(() => {
      window.__hostFocusTrapEvents = [];

      const hostDialog = document.createElement('div');
      hostDialog.id = 'host-dialog-content';
      hostDialog.tabIndex = -1;
      hostDialog.textContent = 'Host dialog';
      document.body.appendChild(hostDialog);
      hostDialog.focus();

      document.addEventListener(
        'focusin',
        event => {
          const host = document.getElementById('bugdrop-host');
          const target = event.target as Node | null;
          if (!host || !target || hostDialog.contains(target)) {
            return;
          }

          if (event.composedPath().includes(host)) {
            window.__hostFocusTrapEvents?.push((target as Element).id || 'bugdrop-host');
            hostDialog.focus();
          }
        },
        true
      );
    });

    const host = await openFeedbackForm(page);

    const titleInput = host.locator('css=#title');
    await titleInput.click();
    await page.keyboard.type('Radix title');
    await expect(titleInput).toHaveValue('Radix title');

    const descriptionInput = host.locator('css=#description');
    await descriptionInput.click();
    await page.keyboard.type('Radix description');
    await expect(descriptionInput).toHaveValue('Radix description');

    await expect.poll(() => page.evaluate(() => window.__hostFocusTrapEvents)).toEqual([]);
  });

  test('widget text fields remain editable inside Radix-style focusout traps', async ({ page }) => {
    await mockInstalledRepo(page);

    await page.goto('/test/welcome-disabled.html');
    await page.evaluate(() => {
      window.__hostFocusOutTrapEvents = [];

      const hostDialog = document.createElement('div');
      hostDialog.id = 'host-dialog-content';
      hostDialog.tabIndex = -1;
      hostDialog.textContent = 'Host dialog';
      document.body.appendChild(hostDialog);
      hostDialog.focus();

      document.addEventListener('focusout', event => {
        const relatedTarget = event.relatedTarget as Node | null;
        if (!relatedTarget || hostDialog.contains(relatedTarget)) {
          return;
        }

        window.__hostFocusOutTrapEvents?.push((relatedTarget as Element).id || 'bugdrop-host');
        hostDialog.focus();
      });
    });

    const host = await openFeedbackForm(page);

    const titleInput = host.locator('css=#title');
    await titleInput.click();
    await page.keyboard.type('Radix title');
    await expect(titleInput).toHaveValue('Radix title');

    const descriptionInput = host.locator('css=#description');
    await descriptionInput.click();
    await page.keyboard.type('Radix description');
    await expect(descriptionInput).toHaveValue('Radix description');

    await expect.poll(() => page.evaluate(() => window.__hostFocusOutTrapEvents)).toEqual([]);
  });

  test('host dialog can receive focus again after editing BugDrop fields', async ({ page }) => {
    await mockInstalledRepo(page);

    await page.goto('/test/welcome-disabled.html');
    await page.evaluate(() => {
      const hostDialog = document.createElement('div');
      hostDialog.id = 'host-dialog-content';
      hostDialog.innerHTML = `
        <input id="host-first" aria-label="Host first input" />
        <input id="host-second" aria-label="Host second input" />
      `;
      document.body.appendChild(hostDialog);

      window.__hostFocusTrapEvents = [];

      document.addEventListener('focusin', event => {
        const target = event.target as Element | null;
        if (target && hostDialog.contains(target)) {
          window.__hostFocusTrapEvents?.push(target.id);
        }
      });

      const firstInput = document.getElementById('host-first') as HTMLInputElement;
      firstInput.focus();
      window.__hostFocusTrapEvents = [];
    });

    const host = await openFeedbackForm(page);

    const titleInput = host.locator('css=#title');
    await titleInput.click();
    await page.keyboard.type('Radix title');
    await expect(titleInput).toHaveValue('Radix title');

    await page.locator('#host-second').focus();
    await expect(page.locator('#host-second')).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => window.__hostFocusTrapEvents))
      .toEqual(['host-second']);
  });

  test('keyboard focus into BugDrop fields stays editable inside focusout traps', async ({
    page,
  }) => {
    await mockInstalledRepo(page);

    await page.goto('/test/welcome-disabled.html');
    await page.evaluate(() => {
      const hostDialog = document.createElement('div');
      hostDialog.id = 'host-dialog-content';
      hostDialog.innerHTML = '<input id="host-title" aria-label="Host title" />';
      document.body.appendChild(hostDialog);

      const hostTitle = document.getElementById('host-title') as HTMLInputElement;
      document.addEventListener('focusout', event => {
        const relatedTarget = event.relatedTarget as Node | null;
        if (!relatedTarget || hostDialog.contains(relatedTarget)) {
          return;
        }

        hostTitle.focus();
      });

      hostTitle.focus();
    });

    const host = await openFeedbackForm(page);

    await page.locator('#host-title').focus();
    const titleInput = host.locator('css=#title');
    await titleInput.focus();
    await expect(titleInput).toBeFocused();
    await page.keyboard.type('Keyboard title');
    await expect(titleInput).toHaveValue('Keyboard title');

    await page.locator('#host-title').focus();
    const descriptionInput = host.locator('css=#description');
    await descriptionInput.focus();
    await expect(descriptionInput).toBeFocused();
    await page.keyboard.type('Keyboard description');
    await expect(descriptionInput).toHaveValue('Keyboard description');
  });
});
