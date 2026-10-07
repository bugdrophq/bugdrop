// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapManagedWidget } from '../src/widget/managed/index';
import { createManagedUI } from '../src/widget/managed/ui';
import type { Binding, Feedback, Outcome, TokenProvider } from '../src/widget/managed/protocol';

const transport = vi.hoisted(() => ({ createSubmission: vi.fn() }));
vi.mock('../src/widget/managed/transport', () => transport);

const receiptId = '123e4567-e89b-42d3-a456-426614174000';
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function setupUI(outcomes: Outcome[]) {
  const host = document.createElement('div');
  document.body.append(host);
  const submit = vi.fn(async () => outcomes.shift() ?? { status: 'indeterminate' });
  const createSubmission = vi.fn(async (_feedback: Feedback) => ({ submit }));
  const api = createManagedUI(host, {
    theme: 'auto',
    position: 'bottom-right',
    buttonVisible: true,
    createSubmission,
  });
  const shadow = host.shadowRoot!;
  const find = <T extends Element>(selector: string) => shadow.querySelector<T>(selector)!;
  const fill = (title = 'A title', description = 'A description') => {
    find<HTMLInputElement>('input[name="title"]').value = title;
    find<HTMLTextAreaElement>('textarea[name="description"]').value = description;
  };
  const send = async () => {
    find<HTMLFormElement>('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await tick();
  };
  return { api, shadow, find, fill, send, submit, createSubmission };
}

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as { BugDrop?: unknown }).BugDrop;
  delete (window as unknown as Record<string, unknown>).__bugdropSdkTokenProvider_test;
  vi.restoreAllMocks();
  transport.createSubmission.mockReset();
});

describe('managed feedback UI', () => {
  it('validates fields before preparing and renders injected text inertly', async () => {
    const ui = setupUI([{ status: 'delivered', receiptId }]);
    ui.api.open();
    await ui.send();
    expect(ui.createSubmission).not.toHaveBeenCalled();
    expect(ui.find('[data-role="error"]').textContent).toContain('title');
    ui.fill('<img src=x onerror=alert(1)>', 'A description');
    await ui.send();
    expect(ui.createSubmission).toHaveBeenCalledOnce();
    expect(ui.createSubmission.mock.calls[0][0].title).toBe('<img src=x onerror=alert(1)>');
    expect(ui.shadow.querySelector('img')).toBeNull();
    expect(ui.find('[data-role="status"]').textContent).toBe('Feedback delivered.');
    expect(ui.find('[data-role="receipt"]').textContent).toContain(receiptId);
    expect(ui.find<HTMLFormElement>('form').hidden).toBe(true);
  });

  it('keeps one prepared submission through uncertain and failed check attempts', async () => {
    const ui = setupUI([
      { status: 'indeterminate', receiptId },
      { status: 'authorization_failed' },
      { status: 'delivered', receiptId },
    ]);
    ui.api.open();
    ui.fill();
    await ui.send();
    expect(ui.find('[data-role="status"]').textContent).toContain('could not be confirmed');
    expect(ui.find<HTMLButtonElement>('[data-action="new-report"]').hidden).toBe(true);
    ui.api.close();
    ui.api.open();
    expect(ui.find('[data-role="receipt"]').textContent).toContain(receiptId);
    ui.find<HTMLButtonElement>('[data-action="check-result"]').click();
    await tick();
    expect(ui.find('[data-role="status"]').textContent).toContain('could not be confirmed');
    expect(ui.find('[data-role="receipt"]').textContent).toContain(receiptId);
    ui.find<HTMLButtonElement>('[data-action="check-result"]').click();
    await tick();
    expect(ui.submit).toHaveBeenCalledTimes(3);
    expect(ui.createSubmission).toHaveBeenCalledOnce();
    expect(ui.find<HTMLButtonElement>('[data-action="new-report"]').hidden).toBe(false);
  });

  it('freezes the draft during an in-flight send and preserves the result after closing', async () => {
    let finish!: (outcome: Outcome) => void;
    const pending = new Promise<Outcome>(resolve => {
      finish = resolve;
    });
    const ui = setupUI([]);
    ui.createSubmission.mockResolvedValue({ submit: vi.fn(() => pending) });
    ui.api.open();
    ui.fill('Original', 'Original description');
    await ui.send();
    expect(ui.find<HTMLFormElement>('form').hidden).toBe(true);
    ui.find<HTMLFormElement>('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    ui.api.close();
    ui.api.open();
    expect(ui.createSubmission).toHaveBeenCalledOnce();
    expect(ui.createSubmission.mock.calls[0][0].title).toBe('Original');
    finish({ status: 'indeterminate', receiptId });
    await tick();
    expect(ui.find('[data-role="receipt"]').textContent).toContain(receiptId);
    expect(ui.find<HTMLButtonElement>('[data-action="new-report"]').hidden).toBe(true);
  });

  it.each(['rate_limited', 'invalid_capability', 'replay_detected'] as const)(
    'retries %s with the same submission and unlocks a new report after delivery',
    async code => {
      const ui = setupUI([
        { status: 'rejected', code },
        { status: 'delivered', receiptId },
      ]);
      ui.api.open();
      ui.fill();
      await ui.send();
      const retry = ui.find<HTMLButtonElement>('[data-action="check-result"]');
      expect(retry.hidden).toBe(false);
      expect(retry.textContent).toBe('Try again');
      retry.click();
      await tick();
      expect(ui.createSubmission).toHaveBeenCalledOnce();
      ui.find<HTMLButtonElement>('[data-action="new-report"]').click();
      expect(ui.find<HTMLFormElement>('form').hidden).toBe(false);
      expect(ui.find<HTMLInputElement>('input[name="title"]').value).toBe('');
      expect(ui.find('[data-role="receipt"]').textContent).toBe('');
    }
  );

  it.each(['invalid_request', 'forbidden', 'payload_too_large'] as const)(
    'preserves an editable draft after definitive %s but never after uncertainty',
    async code => {
      const ui = setupUI([{ status: 'rejected', code }]);
      ui.api.open();
      ui.fill('Retain this draft', 'Retain this description');
      await ui.send();
      const edit = ui.find<HTMLButtonElement>('[data-action="new-report"]');
      expect(edit.hidden).toBe(false);
      expect(edit.textContent).toBe('Edit feedback');
      edit.click();
      expect(ui.find<HTMLInputElement>('input[name="title"]').value).toBe('Retain this draft');
      expect(ui.find<HTMLFormElement>('form').hidden).toBe(false);
      await ui.send();
      expect(ui.createSubmission).toHaveBeenCalledTimes(2);
      expect(edit.hidden).toBe(true);
      ui.submit.mockResolvedValueOnce({ status: 'rejected', code });
      ui.find<HTMLButtonElement>('[data-action="check-result"]').click();
      await tick();
      expect(edit.hidden).toBe(true);
      expect(ui.find<HTMLFormElement>('form').hidden).toBe(true);
      expect(ui.find('[data-role="status"]').textContent).toContain('could not be confirmed');
    }
  );

  it('keeps open state, button visibility, theme and focus behavior in the public API', () => {
    const ui = setupUI([]);
    const launcher = ui.find<HTMLButtonElement>('[data-action="open"]');
    expect(ui.api.isButtonVisible()).toBe(true);
    launcher.click();
    expect(ui.api.isOpen()).toBe(true);
    expect(ui.shadow.activeElement).toBe(ui.find('input[name="title"]'));
    ui.api.setTheme('dark');
    expect(ui.find<HTMLElement>('.root').dataset.theme).toBe('dark');
    ui.find<HTMLElement>('[data-role="dialog"]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(ui.api.isOpen()).toBe(false);
    expect(document.activeElement).toBe(ui.shadow.host);
    ui.api.hide();
    expect(ui.api.isButtonVisible()).toBe(false);
    ui.api.show();
    expect(ui.api.isButtonVisible()).toBe(true);
  });
});

describe('managed SDK bootstrap', () => {
  function script(attributes: Record<string, string> = {}) {
    const element = document.createElement('script');
    element.src = 'https://widget.bugdrop.dev/widget.v1.js';
    Object.assign(element.dataset, {
      contractVersion: '1',
      applicationId: 'app_managed_browser_fixture',
      authTokenProvider: '__bugdropSdkTokenProvider_test',
      sdkVersion: '1.2.3',
      ...attributes,
    });
    document.head.append(element);
    vi.spyOn(document, 'currentScript', 'get').mockReturnValue(element);
    return element;
  }

  it.each(['A'.repeat(16_384), 'abc+/='])(
    'boots with the actual SDK attributes and opaque token %#',
    async token => {
      script({ button: 'false', theme: 'dark', position: 'bottom-left' });
      const binding: Binding = { submissionId: receiptId, payloadDigest: 'a'.repeat(64) };
      const provider = vi.fn(async (_binding: Binding) => token);
      (window as unknown as Record<string, unknown>).__bugdropSdkTokenProvider_test = provider;
      let ready = 0;
      window.addEventListener('bugdrop:ready', () => ready++, { once: true });
      transport.createSubmission.mockImplementation(
        async (_feedback: Feedback, endpoint: string, tokenProvider: TokenProvider) => {
          expect(endpoint).toBe('https://widget.bugdrop.dev/v1/submissions');
          expect(await tokenProvider(binding)).toBe(token);
          return { submit: async () => ({ status: 'delivered', receiptId }) };
        }
      );
      const api = bootstrapManagedWidget();
      expect(api).not.toBeNull();
      expect(ready).toBe(1);
      expect(window.BugDrop).toBe(api);
      expect(api?.isButtonVisible()).toBe(false);
      api?.open();
      const shadow = document.getElementById('bugdrop-managed-host')!.shadowRoot!;
      shadow.querySelector<HTMLInputElement>('input[name="title"]')!.value = 'SDK report';
      shadow.querySelector<HTMLTextAreaElement>('textarea[name="description"]')!.value =
        'A description';
      shadow
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await tick();
      expect(provider).toHaveBeenCalledWith(binding);
    }
  );

  it('accepts the SDK HTTP localhost override', () => {
    const current = script();
    current.src = 'http://localhost:4173/widget.managed.v1.js';
    (window as unknown as Record<string, unknown>).__bugdropSdkTokenProvider_test = vi.fn();
    expect(bootstrapManagedWidget()).not.toBeNull();
  });

  it('refuses legacy attributes, unsafe URLs, missing providers and an existing widget', () => {
    const provider = vi.fn();
    (window as unknown as Record<string, unknown>).__bugdropSdkTokenProvider_test = provider;
    const current = script({ repo: 'owner/name' });
    expect(bootstrapManagedWidget()).toBeNull();
    delete current.dataset.repo;
    current.src = 'https://user:pass@widget.bugdrop.dev/widget.v1.js';
    expect(bootstrapManagedWidget()).toBeNull();
    current.src = 'https://widget.bugdrop.dev/widget.v1.js?x=1';
    expect(bootstrapManagedWidget()).toBeNull();
    current.src = 'https://widget.bugdrop.dev/widget.v1.js';
    delete (window as unknown as Record<string, unknown>).__bugdropSdkTokenProvider_test;
    expect(bootstrapManagedWidget()).toBeNull();
    (window as unknown as Record<string, unknown>).__bugdropSdkTokenProvider_test = provider;
    (window as unknown as { BugDrop?: unknown }).BugDrop = {};
    expect(bootstrapManagedWidget()).toBeNull();
    expect(document.getElementById('bugdrop-managed-host')).toBeNull();
  });
});
