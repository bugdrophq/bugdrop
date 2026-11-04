# Custom Icon via `data-icon`

## Problem

The trigger button icon is hardcoded as the `🐛` emoji. Users cannot customize it to match their brand or product.

## Solution

Add a `data-icon` attribute that accepts an image URL. When provided, the emoji is replaced with an `<img>` element. On load failure, it falls back to the default emoji.

## API

```html
<script src="https://bugdrop.neonwatty.workers.dev/widget.js"
        data-repo="owner/repo"
        data-icon="https://example.com/my-logo.svg"></script>
```

## Config Change

Add `iconUrl?: string` to `WidgetConfig`, parsed from `script?.dataset.icon`.

## DOM Change

Extract a helper function used by both trigger button creation sites:

```typescript
function getTriggerIconHtml(config: WidgetConfig): string {
  if (config.iconUrl) {
    return `<img src="${config.iconUrl}" alt="" onerror="this.style.display='none';this.nextSibling.style.display=''"><span style="display:none">🐛</span>`;
  }
  return '🐛';
}
```

Both `initWidget` (line 279) and `createTriggerButton` (line 398) use this helper inside `.bd-trigger-icon`.

## CSS Change

Add sizing rule for custom icon images:

```css
.bd-trigger-icon img {
  width: 18px;
  height: 18px;
  object-fit: contain;
  display: block;
}
```

Mobile media query scales to 16px to match existing emoji size reduction.

## Tests

1. Custom icon renders with correct `src` inside `.bd-trigger-icon`
2. Broken URL falls back to default emoji
3. Default emoji still works without `data-icon` (covered by existing tests)

## Files Changed

- `src/widget/index.ts` - config parsing + trigger icon rendering
- `src/widget/ui.ts` - CSS rule for img sizing
- `e2e/widget.spec.ts` - 2 new E2E tests
- `README.md` - add `data-icon` to options table
- `public/test/index.html` - optional test page variant
