import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

type Point = [number, number];
type Crop = [x: number, y: number, width: number, height: number];

const origin = 'http://bugdrop.localhost';
const green = [34, 197, 94, 255];
const amber = [245, 158, 11, 255];
const navy = [23, 37, 84, 255];
const black = [0, 0, 0, 255];

async function openFixture(page: Page, body: string) {
  const submissions: { screenshot: string }[] = [];
  await page.route(`${origin}/**`, route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/widget.js') {
      return route.fulfill({
        contentType: 'application/javascript',
        path: resolve('public/widget.js'),
      });
    }
    if (pathname.startsWith('/api/check/')) {
      return route.fulfill({ json: { installed: true } });
    }
    if (pathname === '/api/feedback') {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ json: { success: true, issueNumber: 1, issueUrl: '#' } });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8">
        <style>
          html, body { margin: 0; background: #172554; }
          .document { position: relative; width: 1500px; height: 2200px; }
          .scroller { position: absolute; overflow: auto; scrollbar-width: none; }
          .surface { position: relative; width: 1200px; height: 1400px; }
          .tile { position: absolute; background: #22c55e; }
          .private { background: #ef4444; }
        </style>
        <div class="document">${body}</div>
        <script src="/widget.js" data-repo="example/area-test" data-screenshot="optional"
          data-screenshot-scale="2"></script>`,
    });
  });
  await page.goto(origin);
  return submissions;
}

async function selectArea(page: Page, [x, y, width, height]: Crop) {
  const host = page.locator('#bugdrop-host');
  await host.locator('.bd-trigger').click();
  await host.locator('[data-action="continue"]').click();
  await host.locator('#title').fill('Scroll capture');
  await host.locator('#include-screenshot').check();
  await host.locator('#submit-btn').click();
  await host.locator('[data-action="area"]').click();
  await expect(page.locator('#bugdrop-area-picker-overlay')).toBeVisible();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + width, y + height, { steps: 5 });
  await page.mouse.up();
  const canvas = host.locator('#annotation-canvas canvas');
  await expect(canvas).toBeVisible();
  return {
    host,
    preview: await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL()),
  };
}

async function pixels(page: Page, image: string, crop: Crop, points: Point[]) {
  return page.evaluate(
    async ({ image, crop, points }) => {
      const img = new Image();
      img.src = image;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const [left, top, width, height] = crop;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return {
        size: [canvas.width, canvas.height],
        containsPrivateTile: data.some(
          (r, i) => i % 4 === 0 && r === 239 && data[i + 1] === 68 && data[i + 2] === 68
        ),
        colors: points.map(([x, y]) =>
          Array.from(
            ctx.getImageData(
              Math.floor(((x - left) * canvas.width) / width),
              Math.floor(((y - top) * canvas.height) / height),
              1,
              1
            ).data
          )
        ),
      };
    },
    { image, crop, points }
  );
}

test.use({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });

test('captures the visible scroller area and masks private pixels', async ({ page }) => {
  const crop: Crop = [150, 160, 120, 80];
  const points: Point[] = [
    [180, 195],
    [240, 195],
    [260, 220],
  ];
  const submissions = await openFixture(
    page,
    `<section id="scroll" class="scroller" style="left:40px;top:40px;width:520px;height:430px">
      <div class="surface">
        <div class="tile private" data-bugdrop-mask style="left:110px;top:120px;width:120px;height:80px"></div>
        <div class="tile" id="target" style="left:110px;top:1020px;width:120px;height:80px">
          <div class="tile private" data-bugdrop-mask style="left:78px;top:18px;width:24px;height:35px"></div>
        </div>
      </div>
    </section>`
  );
  const scroller = page.locator('#scroll');
  await scroller.evaluate(node => node.scrollTo(0, 900));
  expect(await page.locator('#target').boundingBox()).toMatchObject({ x: 150, y: 160 });

  const { host, preview } = await selectArea(page, crop);
  expect.soft(await pixels(page, preview, crop, points)).toMatchObject({
    colors: [green, black, green],
    containsPrivateTile: false,
  });
  await host.locator('[data-action="done"]').click();
  await expect(host.locator('.bd-success-icon')).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(await pixels(page, submissions[0].screenshot, crop, points)).toEqual({
    size: [240, 160],
    colors: [green, black, green],
    containsPrivateTile: false,
  });
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(900);
});

test('preserves nested scroller clipping in a crop that also includes the page', async ({
  page,
}) => {
  const crop: Crop = [140, 140, 345, 80];
  const points: Point[] = [
    [160, 170],
    [255, 170],
    [270, 170],
    [455, 170],
  ];
  const submissions = await openFixture(
    page,
    `<section id="outer" class="scroller" style="left:140px;top:240px;width:390px;height:300px">
      <div class="surface" style="background:#f59e0b">
        <section id="inner" class="scroller" style="left:100px;top:220px;width:200px;height:160px">
          <div class="surface" style="background:#22c55e">
            <div class="tile private" data-bugdrop-mask style="left:235px;top:460px;width:65px;height:40px"></div>
          </div>
        </section>
      </div>
    </section>`
  );
  const scrollPositions = () =>
    page.evaluate(() => [
      [window.scrollX, window.scrollY],
      ...['outer', 'inner'].map(id => {
        const node = document.getElementById(id)!;
        return [node.scrollLeft, node.scrollTop];
      }),
    ]);
  await page.evaluate(() => {
    window.scrollTo(100, 200);
    document.getElementById('outer')!.scrollTo(70, 170);
    document.getElementById('inner')!.scrollTo(60, 400);
  });
  expect(await scrollPositions()).toEqual([
    [100, 200],
    [70, 170],
    [60, 400],
  ]);
  expect(await page.locator('#inner').boundingBox()).toMatchObject({ x: 70, y: 90 });

  const { host, preview } = await selectArea(page, crop);
  expect.soft(await pixels(page, preview, crop, points)).toMatchObject({
    colors: [green, black, amber, navy],
    containsPrivateTile: false,
  });
  await host.locator('[data-action="done"]').click();
  await expect(host.locator('.bd-success-icon')).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(await pixels(page, submissions[0].screenshot, crop, points)).toEqual({
    size: [690, 160],
    colors: [green, black, amber, navy],
    containsPrivateTile: false,
  });
  expect(await scrollPositions()).toEqual([
    [100, 200],
    [70, 170],
    [60, 400],
  ]);
});

test('keeps a sticky header at its visible position inside a scroller', async ({ page }) => {
  const crop: Crop = [70, 48, 180, 90];
  const points: Point[] = [
    [90, 65],
    [90, 105],
  ];
  const submissions = await openFixture(
    page,
    `<section id="scroll" class="scroller" style="left:40px;top:40px;width:520px;height:430px">
      <div class="surface" style="background:#f59e0b">
        <header style="position:sticky;top:0;height:40px;background:#22c55e"></header>
      </div>
    </section>`
  );
  await page.locator('#scroll').evaluate(node => node.scrollTo(0, 500));
  expect(await page.locator('header').boundingBox()).toMatchObject({ y: 40 });

  const { host, preview } = await selectArea(page, crop);
  expect.soft((await pixels(page, preview, crop, points)).colors).toEqual([green, amber]);
  await host.locator('[data-action="done"]').click();
  await expect(host.locator('.bd-success-icon')).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect((await pixels(page, submissions[0].screenshot, crop, points)).colors).toEqual([
    green,
    amber,
  ]);
});

test('preserves escaped overlays and sibling paint order inside scrolled content', async ({
  page,
}) => {
  const crop: Crop = [75, 65, 445, 148];
  const points: Point[] = [
    [125, 120],
    [390, 140],
    [475, 172],
  ];
  const submissions = await openFixture(
    page,
    `<section id="scroll" style="margin:0 40px;width:220px;height:180px;overflow:auto;
      scrollbar-width:none;display:grid;grid-template-rows:900px;scroll-padding:20px">
      <div style="position:relative;grid-area:1/1">
        <div style="position:absolute;inset:0 20px;z-index:4;background:#22c55e"></div>
      </div>
      <div style="position:relative;grid-area:1/1;background:#f59e0b;scroll-snap-align:start"></div>
      <div style="grid-area:1/1">
        <div id="fixed" style="position:fixed;left:355px;top:115px;width:65px;height:55px;background:#22c55e"></div>
        <div id="absolute" style="position:absolute;left:450px;top:155px;width:65px;height:55px;background:#22c55e"></div>
      </div>
    </section>`
  );
  await page.locator('#scroll').evaluate(node => node.scrollTo(0, 275));
  expect(await page.locator('#fixed').boundingBox()).toMatchObject({ x: 355, y: 115 });
  expect(await page.locator('#absolute').boundingBox()).toMatchObject({ x: 450, y: 155 });
  await expectSubmissionPixels(page, crop, points, [green, green, green], submissions);
});

for (const kind of ['HTML', 'SVG'] as const) {
  test(`masks a fixed ${kind} element that escapes a scroller`, async ({ page }) => {
    const crop: Crop = [205, 100, 275, 100];
    const points: Point[] = [
      [395, 145],
      [345, 105],
    ];
    const style = 'position:fixed;left:355px;top:120px;width:100px;height:60px';
    const fixed =
      kind === 'HTML'
        ? `<div data-bugdrop-mask class="private" style="${style}"></div>`
        : `<svg data-bugdrop-mask style="${style}"><rect width="100" height="60" fill="#ef4444"/></svg>`;
    const submissions = await openFixture(
      page,
      `<section id="scroll" class="scroller" style="left:40px;top:40px;width:220px;height:180px">
        <div style="height:900px"></div>
        ${fixed}
      </section>`
    );
    await page.locator('#scroll').evaluate(node => node.scrollTo(0, 275));
    await expectSubmissionPixels(page, crop, points, [black, navy], submissions, 1);
  });
}

test('preserves nested CSS math in a direct sticky header translation', async ({ page }) => {
  const crop: Crop = [90, 50, 115, 65];
  const points: Point[] = [
    [115, 67],
    [115, 105],
  ];
  const submissions = await openFixture(
    page,
    `<section id="scroll" class="scroller" style="left:40px;top:40px;width:500px;height:350px;background:#f59e0b">
      <header style="position:sticky;top:0;width:150px;height:40px;background:#22c55e;
        translate:calc(min(20%, 10px) + max(30%, 20px)) 6px"></header>
      <div style="height:900px"></div>
    </section>`
  );
  await page.locator('#scroll').evaluate(node => node.scrollTo(0, 300));
  expect(await page.locator('header').boundingBox()).toMatchObject({ y: 46 });
  await expectSubmissionPixels(page, crop, points, [green, amber], submissions);
});

test('captures a scrolled text-only element without moving the live page', async ({ page }) => {
  const crop: Crop = [78, 50, 120, 75];
  const points: Point[] = [
    [112, 60],
    [112, 100],
  ];
  const text = '   \n'.repeat(20) + '██████████\n██████████\n' + '   \n'.repeat(20);
  const submissions = await openFixture(
    page,
    `<pre id="scroll" style="margin:0 40px;width:220px;height:120px;overflow:hidden;
      scrollbar-width:none;font:30px/40px monospace;color:#22c55e">${text}</pre>`
  );
  const scroller = page.locator('#scroll');
  await scroller.evaluate(node => node.scrollTo(0, 760));
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(760);
  await expectSubmissionPixels(page, crop, points, [green, green], submissions);
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(760);
});

test('uses a cloneable snap anchor when a hidden image precedes visible content', async ({
  page,
}) => {
  const crop: Crop = [80, 95, 100, 75];
  const submissions = await openFixture(
    page,
    `<section id="scroll" class="scroller" style="left:40px;top:40px;width:220px;height:180px">
      <img alt="" style="display:block;visibility:hidden;width:32px;height:32px">
      <div class="surface">
        <div id="target" class="tile" style="left:30px;top:303px;width:100px;height:60px"></div>
      </div>
    </section>`
  );
  await page.locator('#scroll').evaluate(node => node.scrollTo(0, 275));
  expect(await page.locator('#target').boundingBox()).toMatchObject({ y: 100 });
  await expectSubmissionPixels(page, crop, [[95, 125]], [green], submissions);
});

test('capturing outside a scroller does not require a snap anchor for it', async ({ page }) => {
  const crop: Crop = [360, 95, 125, 80];
  const submissions = await openFixture(
    page,
    `<section id="scroll" style="margin:0 40px;width:220px;height:180px;overflow:auto;
      display:flex;flex-direction:column">
      <article style="position:sticky;top:0;flex:none;height:900px"></article>
    </section>
    <div class="tile" style="left:360px;top:95px;width:125px;height:80px"></div>`
  );
  const scroll = page.locator('#scroll');
  await scroll.evaluate(node => node.scrollTo(0, 275));
  expect(await scroll.evaluate(node => node.scrollTop)).toBe(275);
  await expectSubmissionPixels(page, crop, [[420, 135]], [green], submissions);
});

test('captures the visible part of a flex scroller containing a single tall sticky item', async ({
  page,
}) => {
  const crop: Crop = [75, 45, 130, 90];
  const submissions = await openFixture(
    page,
    `<section id="scroll" style="margin:0 40px;width:220px;height:180px;overflow:auto;
      display:flex;flex-direction:column">
      <article style="position:sticky;top:0;flex:none;height:900px;background:#f59e0b">
        <div id="target" class="tile" style="left:20px;top:300px;width:140px;height:105px"></div>
      </article>
    </section>`
  );
  await page.locator('#scroll').evaluate(node => node.scrollTo(0, 275));
  expect(await page.locator('#target').boundingBox()).toMatchObject({ x: 60, y: 25 });
  await expectSubmissionPixels(page, crop, [[100, 85]], [green], submissions);
});

test('restores the local scroll offset of a rotated scroller', async ({ page }) => {
  const crop: Crop = [412, 405, 44, 44];
  const submissions = await openFixture(
    page,
    `<section id="scroll" class="scroller" style="left:420px;top:300px;width:200px;height:160px;
      transform:rotate(45deg);transform-origin:0 0">
      <div class="surface" style="width:200px;height:1150px">
        <div class="tile private" style="left:0;top:0;width:200px;height:190px"></div>
        <div id="target" class="tile" style="left:0;top:310px;width:200px;height:190px"></div>
      </div>
    </section>`
  );
  await page.locator('#scroll').evaluate(node => node.scrollTo(0, 310));
  expect(await page.evaluate(() => document.elementFromPoint(434, 427)?.id)).toBe('target');
  await expectSubmissionPixels(page, crop, [[434, 427]], [green], submissions);
});

test('keeps authored snap points when a scroller has no replacement anchor', async ({ page }) => {
  const crop: Crop = [75, 75, 100, 60];
  const submissions = await openFixture(
    page,
    `<section id="scroll" style="margin:0 40px;width:220px;height:160px;overflow:auto;
      display:flex;flex-direction:column;scroll-snap-type:y mandatory;scrollbar-width:none">
      <article style="position:sticky;top:0;flex:none;height:300px;background:#ef4444"></article>
      <article style="position:sticky;top:0;flex:none;height:300px;background:#22c55e;
        scroll-snap-align:start"></article>
      <article style="position:sticky;top:0;flex:none;height:300px;background:#172554"></article>
    </section>`
  );
  await expect.poll(() => page.locator('#scroll').evaluate(node => node.scrollTop)).toBe(300);
  await expectSubmissionPixels(page, crop, [[100, 100]], [green], submissions);
});

test('neutralizes competing snap targets through an inline overflow wrapper', async ({ page }) => {
  const crop: Crop = [75, 75, 100, 60];
  const submissions = await openFixture(
    page,
    `<section id="scroll" class="scroller" style="left:40px;top:40px;width:220px;height:160px">
      <div style="height:300px;background:#22c55e"></div>
      <span style="overflow:hidden">
        <span style="display:block;height:600px;background:#ef4444;scroll-snap-align:start"></span>
      </span>
      <div id="target" style="height:600px;background:#22c55e"></div>
    </section>`
  );
  await page.locator('#scroll').evaluate(node => node.scrollTo(0, 920));
  expect(await page.evaluate(() => document.elementFromPoint(100, 100)?.id)).toBe('target');
  await expectSubmissionPixels(page, crop, [[100, 100]], [green], submissions);
});

test('uses an unzoomed snap anchor when a child has its own CSS zoom', async ({ page }) => {
  const crop: Crop = [60, 55, 90, 90];
  const submissions = await openFixture(
    page,
    `<section id="scroll" class="scroller" style="left:40px;top:40px;width:320px;height:180px">
      <div style="zoom:2;height:50px">
        <div style="height:12.5px"></div><div style="height:25px;background:#22c55e"></div>
      </div>
      <div class="surface" style="width:100%;height:950px;background:#9333ea">
        <div id="target" class="tile" style="left:0;top:275px;width:100%;height:50px"></div>
      </div>
    </section>`
  );
  await page.locator('#scroll').evaluate(node => node.scrollTo(0, 350));
  expect(await page.evaluate(() => document.elementFromPoint(100, 90)?.id)).toBe('target');
  await expectSubmissionPixels(page, crop, [[100, 90]], [green], submissions);
});

test('keeps a visible mask inside a rotated scroller with an asymmetric border', async ({
  page,
}) => {
  const crop: Crop = [385, 120, 45, 100];
  const submissions = await openFixture(
    page,
    `<section id="scroll" class="scroller" style="left:430px;top:100px;width:200px;height:160px;
      border-right:60px solid #f59e0b;transform:rotate(90deg);transform-origin:0 0">
      <div class="surface" style="width:200px;height:1000px;background:#9333ea">
        <div class="tile" style="left:20px;top:5px;width:140px;height:20px"></div>
        <div id="target" class="tile private" data-bugdrop-mask
          style="left:20px;top:305px;width:140px;height:20px"></div>
      </div>
    </section>`
  );
  await page.locator('#scroll').evaluate(node => node.scrollTo(0, 300));
  expect(await page.evaluate(() => document.elementFromPoint(415, 175)?.id)).toBe('target');
  await expectSubmissionPixels(page, crop, [[415, 175]], [black], submissions, 1);
});

async function expectSubmissionPixels(
  page: Page,
  crop: Crop,
  points: Point[],
  colors: number[][],
  submissions: { screenshot: string }[],
  redactionCount?: number
) {
  const { host, preview } = await selectArea(page, crop);
  expect.soft((await pixels(page, preview, crop, points)).colors).toEqual(colors);
  if (redactionCount) {
    await expect
      .soft(
        host.locator('.bd-redaction-note').filter({ hasText: `${redactionCount} private item` })
      )
      .toContainText('was marked for redaction');
  }
  await host.locator('[data-action="done"]').click();
  await expect(host.locator('.bd-success-icon')).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect((await pixels(page, submissions[0].screenshot, crop, points)).colors).toEqual(colors);
}
