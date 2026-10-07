const managedStyles = `
  :host { all: initial; color-scheme: light dark; font-family: system-ui, sans-serif; }
  *, *::before, *::after { box-sizing: border-box; }
  .root { --bg: #fff; --fg: #17202a; --muted: #536171; --border: #b7c2ce;
    --accent: #1769aa; color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
  .root[data-theme="dark"] { --bg: #17202a; --fg: #f4f7fa; --muted: #bdc8d2;
    --border: #69798a; --accent: #8acbff; }
  @media (prefers-color-scheme: dark) {
    .root[data-theme="auto"] { --bg: #17202a; --fg: #f4f7fa; --muted: #bdc8d2;
      --border: #69798a; --accent: #8acbff; }
  }
  button, input, textarea, select { font: inherit; }
  button { cursor: pointer; }
  button:disabled { cursor: default; opacity: .6; }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  [hidden] { display: none !important; }
  .launcher { position: fixed; z-index: 2147483646; right: 20px; bottom: 20px;
    border: 0; border-radius: 999px; background: #1769aa; color: #fff;
    padding: 11px 18px; box-shadow: 0 5px 18px #0004; }
  .root[data-position="bottom-left"] .launcher { right: auto; left: 20px; }
  .backdrop { position: fixed; inset: 0; z-index: 2147483647; display: grid;
    place-items: center; padding: 16px; background: #0009; }
  .dialog { width: min(100%, 480px); max-height: min(90vh, 720px); overflow: auto;
    border: 1px solid var(--border); border-radius: 14px; background: var(--bg);
    color: var(--fg); box-shadow: 0 14px 48px #0005; padding: 20px; }
  .heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
  h2 { font-size: 20px; line-height: 1.25; margin: 0 0 16px; }
  .close { border: 0; background: transparent; color: var(--fg); font-size: 24px;
    line-height: 1; padding: 0 4px; }
  label { display: block; font-weight: 600; margin: 12px 0 5px; }
  input, textarea, select { display: block; width: 100%; color: var(--fg); background: var(--bg);
    border: 1px solid var(--border); border-radius: 7px; padding: 9px; }
  textarea { min-height: 130px; resize: vertical; }
  .help, .status { color: var(--muted); }
  .help { font-size: 12px; margin: 6px 0 0; }
  .error { color: #b42318; margin: 10px 0; }
  .actions { display: flex; align-items: center; gap: 10px; margin-top: 18px; }
  .primary { border: 0; border-radius: 7px; padding: 9px 15px; background: #1769aa; color: #fff; }
  .secondary { border: 1px solid var(--border); border-radius: 7px; padding: 8px 14px;
    background: var(--bg); color: var(--fg); }
  .status { margin: 14px 0 0; }
  .receipt { display: block; overflow-wrap: anywhere; font-family: ui-monospace, monospace;
    color: var(--fg); margin-top: 4px; }
`;

/** Static markup only: feedback and provider data are assigned through DOM properties. */
export const managedMarkup = `
  <style>${managedStyles}</style>
  <div class="root" data-theme="auto" data-position="bottom-right">
    <button class="launcher" type="button" data-action="open">Feedback</button>
    <div class="backdrop" hidden>
      <section class="dialog" data-role="dialog" role="dialog" aria-modal="true" aria-labelledby="managed-title">
        <div class="heading"><h2 id="managed-title">Send feedback</h2>
          <button class="close" type="button" data-action="close" aria-label="Close feedback">×</button></div>
        <form data-role="feedback" novalidate>
          <label for="managed-feedback-title">Title</label>
          <input id="managed-feedback-title" name="title" type="text" required maxlength="256" />
          <label for="managed-feedback-description">Description</label>
          <textarea id="managed-feedback-description" name="description" required maxlength="16384"></textarea>
          <p class="help">Plain text only. Screenshots and attachments are unavailable.</p>
          <label for="managed-feedback-category">Category (optional)</label>
          <select id="managed-feedback-category" name="category">
            <option value="">No category</option><option value="bug">Bug</option>
            <option value="feature">Feature</option><option value="question">Question</option>
          </select>
          <p class="error" data-role="error" role="alert" hidden></p>
          <div class="actions"><button class="primary" type="submit" data-action="submit">Send feedback</button></div>
        </form>
        <div data-role="result" hidden>
          <p class="status" data-role="status" role="status" aria-live="polite" tabindex="-1"></p>
          <span class="receipt" data-role="receipt"></span>
          <div class="actions">
            <button class="secondary" type="button" data-action="check-result" hidden>Check result</button>
            <button class="secondary" type="button" data-action="new-report" hidden>Send another report</button>
          </div>
        </div>
      </section>
    </div>
  </div>
`;
