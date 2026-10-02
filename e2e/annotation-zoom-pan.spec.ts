import { devices, expect, test } from '@playwright/test';

test('mobile zoom controls have usable touch targets and respond to repeated taps', async ({
  browser,
}) => {
  const context = await browser.newContext({ ...devices['iPhone 11'] });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      (
        window as typeof window & { __bugdropMockToPng?: () => Promise<string> }
      ).__bugdropMockToPng = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 1600;
        return canvas.toDataURL('image/png');
      };
    });
    await page.goto('/test/?localQa=1');
    const host = page.locator('#bugdrop-host');
    await host.locator('.bd-trigger').tap();
    await host.locator('[data-action="continue"]').tap();
    await host.locator('#title').fill('Mobile touch controls');
    await host.locator('#include-screenshot').check();
    await host.locator('#submit-btn').tap();
    await host.locator('[data-action="capture"]').tap();
    await expect(host.locator('#annotation-canvas canvas')).toBeVisible();

    const zoomIn = host.locator('[data-view="in"]');
    const bounds = await zoomIn.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await zoomIn.tap();
    await zoomIn.tap();
    await expect(host.locator('.bd-zoom-level')).toHaveText('200%');

    await host.locator('[data-tool="pan"]').tap();
    await expect(host.locator('[data-tool="pan"]')).toHaveClass(/active/);

    await host.locator('[data-tool="rect"]').tap();
    await host.locator('#annotation-canvas canvas').evaluate(canvas => {
      const bounds = canvas.getBoundingClientRect();
      const point = { x: bounds.left + 30, y: bounds.top + 30 };
      const options = { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true };
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', { ...options, clientX: point.x, clientY: point.y })
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { ...options, clientX: point.x + 40, clientY: point.y + 40 })
      );
    });
    await host.locator('[data-action="mobile-retake"]').tap();
    await expect(host.locator('.bd-retake-confirm')).toBeVisible();
    await expect(host.locator('[data-action="keep-editing"]')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(host.locator('[data-action="confirm-retake"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(host.locator('[data-action="keep-editing"]')).toBeFocused();
    await host.locator('[data-action="keep-editing"]').tap();
    await host.locator('[data-action="undo"]').tap();
    await host.locator('[data-action="mobile-retake"]').tap();
    await expect(host.locator('.bd-modal--annotator')).toBeHidden();
  } finally {
    await context.close();
  }
});

test('mobile dock keeps navigation separate from tools across phone sizes', async ({ browser }) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
    { width: 430, height: 932 },
    { width: 667, height: 375 },
    { width: 896, height: 414 },
    { width: 932, height: 430 },
  ]) {
    const context = await browser.newContext({ ...devices['iPhone 11'], viewport });
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        (
          window as typeof window & { __bugdropMockToPng?: () => Promise<string> }
        ).__bugdropMockToPng = async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 800;
          canvas.height = 1600;
          return canvas.toDataURL('image/png');
        };
      });
      await page.goto('/test/?localQa=1');
      const host = page.locator('#bugdrop-host');
      await host.locator('.bd-trigger').tap();
      await host.locator('[data-action="continue"]').tap();
      await host.locator('#title').fill('Mobile layout');
      await host.locator('#include-screenshot').check();
      await host.locator('#submit-btn').tap();
      await host.locator('[data-action="capture"]').tap();
      await expect(host.locator('#annotation-canvas canvas')).toBeVisible();
      await expect(host.locator('.bd-annotation-instruction')).toBeHidden();
      await host.locator('.bd-modal--annotator').evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished));
      });
      await expect
        .poll(() =>
          host
            .locator('.bd-modal--annotator')
            .evaluate(element => element.getBoundingClientRect().top)
        )
        .toBeLessThanOrEqual(1);

      const { retake, review, stage, dock, close, tools } = await host
        .locator('.bd-modal--annotator')
        .evaluate(modal => {
          const box = (element: Element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          const select = (selector: string) => box(modal.querySelector(selector)!);
          return {
            retake: select('[data-action="mobile-retake"]'),
            review: select('[data-action="review"]'),
            stage: select('#annotation-canvas'),
            dock: select('.bd-tools'),
            close: select('.bd-close'),
            tools: Array.from(modal.querySelectorAll('.bd-tools .bd-tool'), box),
          };
        });
      expect(retake.height).toBeGreaterThanOrEqual(44);
      expect(review.height).toBeGreaterThanOrEqual(44);
      expect(close.width).toBeGreaterThanOrEqual(43.9);
      expect(close.height).toBeGreaterThanOrEqual(43.9);
      expect(stage.height).toBeGreaterThanOrEqual(60);
      expect(retake.y + retake.height).toBeLessThan(stage.y);
      expect(review.y + review.height).toBeLessThan(stage.y);
      expect(dock.y).toBeGreaterThanOrEqual(stage.y + stage.height);
      await expect(host.locator('[data-tool="pan"]')).toHaveAttribute('aria-pressed', 'true');
      expect(tools).toHaveLength(6);
      for (const bounds of tools) {
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
      await expect(host.locator('[data-action="send-reviewed"]')).toBeHidden();

      await host.locator('[data-action="review"]').tap();
      await expect(host.locator('[data-action="send-reviewed"]')).toBeVisible();
      await expect(host.locator('.bd-annotation-review-instruction')).toBeVisible();
      await expect(host.locator('.bd-tools')).toBeHidden();
      await host.locator('[data-action="back-to-edit"]').tap();
      await expect(host.locator('.bd-tools')).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

test('mobile review sends the annotated image only after the final action', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 11'] });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      (
        window as typeof window & { __bugdropMockToPng?: () => Promise<string> }
      ).__bugdropMockToPng = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 600;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
      };
    });
    await page.goto('/test/?localQa=1');
    const host = page.locator('#bugdrop-host');
    await host.locator('.bd-trigger').tap();
    await host.locator('[data-action="continue"]').tap();
    await host.locator('#title').fill('Annotated mobile submission');
    await host.locator('#include-screenshot').check();
    await host.locator('#submit-btn').tap();
    await host.locator('[data-action="capture"]').tap();
    const canvas = host.locator('#annotation-canvas canvas');
    await expect(canvas).toBeVisible();
    await host.locator('[data-tool="redact"]').tap();
    const sample = await canvas.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const from = { x: rect.left + 30, y: rect.top + 30 };
      const to = { x: from.x + 40, y: from.y + 40 };
      const options = { bubbles: true, pointerId: 8, pointerType: 'touch', isPrimary: true };
      element.dispatchEvent(
        new PointerEvent('pointerdown', { ...options, clientX: from.x, clientY: from.y })
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { ...options, clientX: to.x, clientY: to.y })
      );
      return {
        x: Math.floor(((from.x + to.x) / 2 - rect.left) * (element.width / rect.width)),
        y: Math.floor(((from.y + to.y) / 2 - rect.top) * (element.height / rect.height)),
      };
    });
    const localSubmissions = () =>
      page.evaluate(() =>
        (
          window as typeof window & {
            BugDropLocalSubmissions: {
              list: () => Promise<Array<{ payload: { screenshot: string } }>>;
            };
          }
        ).BugDropLocalSubmissions.list()
      );
    expect(await localSubmissions()).toHaveLength(0);
    await host.locator('[data-action="review"]').tap();
    expect(await localSubmissions()).toHaveLength(0);
    await host.locator('[data-action="send-reviewed"]').tap();
    await expect(host.locator('.bd-success-icon')).toBeVisible();
    const [submission] = await localSubmissions();
    expect(submission.payload.screenshot).toMatch(/^data:image\/png;base64,/);
    const color = await page.evaluate(
      async ({ screenshot, x, y }) => {
        const image = new Image();
        image.src = screenshot;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(x, y, 1, 1).data);
      },
      { screenshot: submission.payload.screenshot, ...sample }
    );
    expect(color).toEqual([0, 0, 0, 255]);
  } finally {
    await context.close();
  }
});

test('long mobile screenshot remains readable and annotations map through zoom and pan', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    (window as typeof window & { __bugdropMockToPng?: () => Promise<string> }).__bugdropMockToPng =
      async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 3200;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
      };
  });
  await page.goto('/test/?localQa=1');
  const host = page.locator('#bugdrop-host');
  await host.locator('.bd-trigger').click();
  await host.locator('[data-action="continue"]').click();
  await host.locator('#title').fill('Zoom and pan test');
  await host.locator('#include-screenshot').check();
  await host.locator('#submit-btn').click();
  await host.locator('[data-action="capture"]').click();

  const stage = host.locator('#annotation-canvas');
  const canvas = stage.locator('canvas');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const initial = await canvas.evaluate(element => {
    const stage = element.parentElement!;
    return {
      bitmap: [element.width, element.height],
      display: element.getBoundingClientRect().width,
      stage: stage.clientWidth,
      scrollHeight: stage.scrollHeight,
      clientHeight: stage.clientHeight,
    };
  });
  expect(initial.bitmap).toEqual([800, 3200]);
  expect(initial.display).toBeGreaterThan(initial.stage * 0.8);
  expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight * 2);

  await host.locator('[data-view="in"]').click();
  await expect(host.locator('output.bd-zoom-level')).toHaveText('150%');
  const zoomedWidth = await canvas.evaluate(element => element.getBoundingClientRect().width);
  expect(zoomedWidth).toBeGreaterThan(initial.display * 1.4);

  await host.locator('[data-tool="pan"]').click();
  const pan = await stage.evaluate(element => {
    element.scrollTop = 600;
    const canvas = element.querySelector('canvas')!;
    const bounds = canvas.getBoundingClientRect();
    const x = bounds.left + 80;
    const y = bounds.top + 150;
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 7,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y,
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 7,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y - 80,
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 7,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y - 80,
      })
    );
    return element.scrollTop;
  });
  expect(pan).toBeGreaterThan(600);

  await host.locator('[data-tool="redact"]').click();
  const pixel = await canvas.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const from = { x: bounds.left + 80, y: bounds.top + 80 };
    const to = { x: from.x + 40, y: from.y + 40 };
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 8,
        pointerType: 'touch',
        isPrimary: true,
        clientX: from.x,
        clientY: from.y,
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 8,
        pointerType: 'touch',
        isPrimary: true,
        clientX: to.x,
        clientY: to.y,
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 8,
        pointerType: 'touch',
        isPrimary: true,
        clientX: to.x,
        clientY: to.y,
      })
    );
    const x = Math.floor(((from.x + to.x) / 2 - bounds.left) * (element.width / bounds.width));
    const y = Math.floor(((from.y + to.y) / 2 - bounds.top) * (element.height / bounds.height));
    return { x, y, color: Array.from(element.getContext('2d')!.getImageData(x, y, 1, 1).data) };
  });
  expect(pixel.color).toEqual([0, 0, 0, 255]);
  expect(pixel.y).toBeGreaterThan(0);

  await host.locator('[data-action="undo"]').click();
  const undone = await canvas.evaluate(
    (element, point) =>
      Array.from(element.getContext('2d')!.getImageData(point.x, point.y, 1, 1).data),
    pixel
  );
  expect(undone).toEqual([255, 255, 255, 255]);

  await host.locator('[data-view="reset"]').click();
  await expect(host.locator('output.bd-zoom-level')).toHaveText('100%');
  expect(await stage.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([0, 0]);
});
