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
  const opened = manager.register(publicationFlow).open({
    context: {
      'account-name': 'Account Name',
      'publication-permission': false,
      'publication-channels': 'website',
    },
  });
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
async function rate(rating: number, comment = 'Great!') {
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
  const input = shadow().querySelector('textarea')!;
  input.value = comment;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const description = (fetcher: ReturnType<typeof vi.fn>, index = 0) =>
  JSON.parse(fetcher.mock.calls[index][1].body).description as string;
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('two-button publication permission', () => {
  for (const permission of [true, false]) {
    it(`collects credit and submits once with permission ${permission}`, async () => {
      const { opened, fetcher } = open();
      await rate(5);
      (await button('Continue')).click();
      const submit = await button(
        permission ? 'Yes, you can share this' : 'Keep my feedback private'
      );
      expect(shadow().querySelector('input[type="radio"]')).toBeNull();
      expect(
        [...shadow().querySelectorAll('button')].some(button => button.textContent === 'Submit')
      ).toBe(false);
      expect(shadow().querySelector('blockquote')?.textContent).toBe('Great!');
      const credit = shadow().querySelector<HTMLInputElement>('input')!;
      expect(credit.value).toBe('Account Name');
      credit.value = 'Edited Credit';
      credit.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
      expect(submit.textContent).toBe(
        permission ? 'Yes, you can share this' : 'Keep my feedback private'
      );
      expect(fetcher).not.toHaveBeenCalled();
      const opposite = await button(
        permission ? 'Keep my feedback private' : 'Yes, you can share this'
      );
      submit.click();
      // An opposite choice while the first submit is pending must not replace metadata.
      opposite.click();
      await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(description(fetcher)).toContain(`## Publication permission\n\n${permission}`);
      expect(description(fetcher)).toContain('## Publication channels\n\nwebsite');
      expect(description(fetcher)).toContain('Edited Credit');
      expect(description(fetcher)).not.toContain('Account Name');
      opened.close();
    });
  }

  for (const rating of [1, 2, 3, 4]) {
    it(`${rating} stars submits privately without the sharing screen`, async () => {
      const { opened, fetcher } = open();
      await rate(rating);
      (await button('Submit')).click();
      await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(description(fetcher)).toContain('## Publication permission\n\nfalse');
      expect(description(fetcher)).not.toContain('## Credit');
      expect(description(fetcher)).not.toContain('Account Name');
      opened.close();
    });
  }

  it('offers a quote only when the comment is empty and enforces 5 characters', async () => {
    const { opened, fetcher } = open();
    await rate(5, '');
    (await button('Continue')).click();
    await button('Continue');
    await vi.waitFor(() => expect(shadow().textContent).toContain('Your quote (optional)'));
    const quote = shadow().querySelector('textarea')!;
    quote.value = 'Nice';
    (await button('Continue')).click();
    await vi.waitFor(() => expect(shadow().querySelector('.bdv-error')).not.toBeNull());
    expect(fetcher).not.toHaveBeenCalled();
    quote.value = 'Great';
    (await button('Continue')).click();
    await button('Yes, you can share this');
    expect(shadow().querySelector('blockquote')?.textContent).toBe('Great');
    shadow().querySelector<HTMLInputElement>('input')!.value = '';
    (await button('Yes, you can share this')).click();
    await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
    expect(description(fetcher)).toContain('> Great');
    expect(description(fetcher)).not.toContain('## Credit');
    opened.close();
  });

  it('Back to a lower rating clears abandoned credit and quote', async () => {
    const { opened, fetcher } = open();
    await rate(5, '');
    (await button('Continue')).click();
    await vi.waitFor(() => expect(shadow().textContent).toContain('Your quote (optional)'));
    shadow().querySelector('textarea')!.value = 'Abandoned quote';
    (await button('Continue')).click();
    await button('Yes, you can share this');
    shadow().querySelector<HTMLInputElement>('input')!.value = 'Abandoned credit';
    (await button('Back')).click();
    await vi.waitFor(() => expect(shadow().textContent).toContain('Your quote (optional)'));
    (await button('Back')).click();
    await rate(4);
    (await button('Submit')).click();
    await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(description(fetcher)).toContain('## Publication permission\n\nfalse');
    expect(description(fetcher)).not.toContain('Abandoned');
    opened.close();
  });

  it('retries with the chosen permission and edited credit', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(success());
    const { opened } = open(fetcher);
    await rate(5);
    (await button('Continue')).click();
    await button('Keep my feedback private');
    shadow().querySelector<HTMLInputElement>('input')!.value = 'Edited Credit';
    (await button('Keep my feedback private')).click();
    await vi.waitFor(() => expect(shadow().textContent).toContain('Submission failed'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    (await button('Try again')).click();
    await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      expect(description(fetcher, i)).toContain('## Publication permission\n\nfalse');
      expect(description(fetcher, i)).toContain('Edited Credit');
    }
    opened.close();
  });

  it('closing before choosing a button creates no Issue', async () => {
    const { opened, fetcher } = open();
    await rate(5);
    (await button('Continue')).click();
    await button('Yes, you can share this');
    opened.close();
    await expect(opened.result).resolves.toEqual({ status: 'closed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains native hidden-answer cleanup for initially hidden seeds', () => {
    const definition = normalizeFlowDefinition(validateAndFreezeFlowConfig(publicationFlow));
    const runtime = new FlowRuntime(
      definition,
      {},
      { 'sharing.credit': 'Hidden seed', 'quote.text': 'Hidden quote' }
    );
    expect(runtime.answers['sharing.credit']).toBeUndefined();
    expect(runtime.answers['quote.text']).toBeUndefined();
  });
});
