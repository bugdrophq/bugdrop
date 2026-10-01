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
  expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight * 3);

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
