// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlowManager } from '../src/widget/flows/manager';
import { normalizeFlowDefinition } from '../src/widget/flows/definition';
import { FlowRuntime } from '../src/widget/flows/runtime';
import { validateAndFreezeFlowConfig } from '../src/widget/flows/validate-config';
import { publicationFlow } from './fixtures/publication-flow';

function success() {
  return {
    ok: true,
    json: async () => ({
      success: true,
      issueNumber: 1,
      issueUrl: 'https://github.com/owner/repo/issues/1',
      isPublic: false,
    }),
  };
}

function open(fetcher = vi.fn().mockResolvedValue(success())) {
  vi.stubGlobal('fetch', fetcher);
  const manager = createFlowManager(
    { repo: 'owner/repo', apiUrl: '/api' },
    {
      preflight: async () => ({ status: 'installed' }),
      capture: async () => ({
        screenshot: null,
        elementSelector: null,
        fullElementSelector: null,
        returnToForm: false,
      }),
    }
  );
  const opened = manager
    .register(publicationFlow)
    .open({ context: { 'account-name': 'Account Name' } });
  return { opened, fetcher };
}
const shadow = () => document.querySelector('[data-bugdrop-flow]')!.shadowRoot!;
async function button(label: string) {
  await vi.waitFor(() =>
    expect(
      [...shadow().querySelectorAll('button')].some(button => button.textContent === label)
    ).toBe(true)
  );
  return [...shadow().querySelectorAll('button')].find(button => button.textContent === label)!;
}
async function choose(value: string) {
  const choice = shadow().querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
  choice.click();
  await Promise.resolve();
  await Promise.resolve();
}
async function rate(rating: number) {
  await vi.waitFor(() =>
    expect(
      shadow().querySelector(`[aria-label="${rating} ${rating === 1 ? 'star' : 'stars'}"]`)
    ).not.toBeNull()
  );
  shadow()
    .querySelector<HTMLButtonElement>(
      `[aria-label="${rating} ${rating === 1 ? 'star' : 'stars'}"]`
    )!
    .click();
  const quote = shadow().querySelector('textarea')!;
  quote.value = 'Great!';
  quote.dispatchEvent(new Event('input', { bubbles: true }));
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('publication permission using existing flow primitives', () => {
  for (const permission of ['yes', 'no']) {
    it(`uses ordinary Submit to send one Issue after ${permission}`, async () => {
      const { opened, fetcher } = open();
      await rate(5);
      (await button('Continue')).click();
      await vi.waitFor(() => expect(shadow().textContent).toContain('Publication permission'));
      expect(shadow().querySelector('input:checked')).toBeNull();
      (await button('Submit')).click();
      await vi.waitFor(() => expect(shadow().querySelector('.bdv-error')).not.toBeNull());
      expect(fetcher).not.toHaveBeenCalled();
      await choose(permission);
      if (permission === 'yes') {
        (await button('Continue')).click();
        await vi.waitFor(() =>
          expect(shadow().querySelector<HTMLInputElement>('input')?.value).toBe('Account Name')
        );
        shadow().querySelector<HTMLInputElement>('input')!.value = 'Edited Credit';
      } else {
        expect(shadow().textContent).not.toContain('Show my quote as');
      }
      expect(fetcher).not.toHaveBeenCalled();
      const submit = await button('Submit');
      submit.click();
      submit.click();
      await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const description = JSON.parse(fetcher.mock.calls[0][1].body).description;
      expect(description).toContain(`## Publication permission\n\n${permission}`);
      expect(description.includes('## Credit')).toBe(permission === 'yes');
      expect(description).not.toContain('Account Name');
      if (permission === 'yes') expect(description).toContain('Edited Credit');
      opened.close();
    });
  }

  for (const rating of [1, 2, 3, 4]) {
    it(`${rating} stars skips permission and attribution without leaking account defaults`, async () => {
      const { opened, fetcher } = open();
      await rate(rating);
      (await button('Submit')).click();
      await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const description = JSON.parse(fetcher.mock.calls[0][1].body).description;
      expect(description).not.toContain('## Publication permission');
      expect(description).not.toContain('## Credit');
      expect(description).not.toContain('Account Name');
      opened.close();
    });
  }

  it('Back then No clears attribution and submits privately exactly once', async () => {
    const { opened, fetcher } = open();
    await rate(5);
    (await button('Continue')).click();
    await vi.waitFor(() => expect(shadow().querySelector('input[value="yes"]')).not.toBeNull());
    await choose('yes');
    (await button('Continue')).click();
    await vi.waitFor(() =>
      expect(shadow().querySelector<HTMLInputElement>('input')?.value).toBe('Account Name')
    );
    shadow().querySelector<HTMLInputElement>('input')!.value = 'Do not retain this';
    (await button('Back')).click();
    await vi.waitFor(() => expect(shadow().querySelector('input[value="no"]')).not.toBeNull());
    await choose('no');
    (await button('Submit')).click();
    await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const description = JSON.parse(fetcher.mock.calls[0][1].body).description;
    expect(description).toContain('## Publication permission\n\nno');
    expect(description).not.toContain('Do not retain this');
    expect(description).not.toContain('## Credit');
    opened.close();
  });

  it('a failed submission retries the chosen answer without creating an early Issue', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(success());
    const { opened } = open(fetcher);
    await rate(5);
    (await button('Continue')).click();
    await vi.waitFor(() => expect(shadow().querySelector('input[value="no"]')).not.toBeNull());
    await choose('no');
    (await button('Submit')).click();
    await vi.waitFor(() => expect(shadow().textContent).toContain('Submission failed'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    shadow().querySelector<HTMLButtonElement>('.bdv-submit')!.click();
    await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, request] of fetcher.mock.calls)
      expect(JSON.parse(request.body).description).toContain('## Publication permission\n\nno');
    opened.close();
  });

  it('closing an unfinished flow creates no Issue', async () => {
    const { opened, fetcher } = open();
    await rate(5);
    (await button('Continue')).click();
    opened.close();
    await expect(opened.result).resolves.toEqual({ status: 'closed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains native hidden-answer cleanup for seeds and Yes-to-No changes', () => {
    const definition = normalizeFlowDefinition(validateAndFreezeFlowConfig(publicationFlow));
    const runtime = new FlowRuntime(definition, {}, { 'attribution.name': 'Hidden seed' });
    expect(runtime.answers['attribution.name']).toBeUndefined();
    runtime.setFormAnswers('experience', { rating: 5, quote: 'Great!' });
    runtime.setFormAnswers('permission', { publish: 'yes' });
    runtime.setFormAnswers('attribution', { name: 'Visible name' });
    runtime.setFormAnswers('permission', { publish: 'no' });
    expect(runtime.answers['attribution.name']).toBeUndefined();
    runtime.setFormAnswers('experience', { rating: 4, quote: 'Okay!' });
    expect(runtime.answers['permission.publish']).toBeUndefined();
  });
});
