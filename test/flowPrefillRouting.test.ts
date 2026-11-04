// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlowManager } from '../src/widget/flows/manager';
import { contextDefaultFlow } from './fixtures/context-default-flow';

const fetcher = vi.fn();
const manager = () =>
  createFlowManager(
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
const shadow = () => document.querySelector('[data-bugdrop-flow]')!.shadowRoot!;
const button = (label: string) =>
  [...shadow().querySelectorAll('button')].find(item => item.textContent === label)!;

afterEach(() => {
  vi.unstubAllGlobals();
  fetcher.mockReset();
  document.body.replaceChildren();
});

describe('context default route preview', () => {
  for (const type of ['shortText', 'longText'] as const) {
    it(`routes from an untouched ${type} default before the first click`, async () => {
      vi.stubGlobal(
        'fetch',
        fetcher.mockResolvedValue({
          ok: true,
          json: async () => ({
            success: true,
            issueNumber: 1,
            issueUrl: 'https://github.com/owner/repo/issues/1',
            isPublic: false,
          }),
        })
      );
      const opened = manager()
        .register(contextDefaultFlow(type))
        .open({ context: { name: 'Alice' } });
      await vi.waitFor(() =>
        expect(shadow().querySelector('.bdf-progress')?.textContent).toBe('Step 1 of 2')
      );
      expect(shadow().querySelector<HTMLInputElement>('input, textarea')!.value).toBe('Alice');
      expect(button('Continue')).toBeDefined();
      expect(fetcher).not.toHaveBeenCalled();
      button('Continue').click();
      await vi.waitFor(() => expect(shadow().textContent).toContain('Follow-up for Alice'));
      expect(fetcher).not.toHaveBeenCalled();
      shadow().querySelector<HTMLInputElement>('input')!.value = 'Follow-up answer';
      button('Submit').click();
      await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetcher.mock.calls[0][1].body).description).toContain('## Name\n\nAlice');
      opened.close();
    });
  }

  it('keeps an explicit blank instead of routing from the context default', async () => {
    const opened = manager()
      .register(contextDefaultFlow('shortText'))
      .open({
        context: { name: 'Alice' },
        initialAnswers: { 'first.text': '' },
      });
    await vi.waitFor(() => expect(shadow().querySelector('input')?.value).toBe(''));
    expect(shadow().querySelector('.bdf-progress')?.textContent).toBe('Step 1 of 1');
    expect(button('Submit')).toBeDefined();
    opened.close();
  });

  it('uses the new context when the same handle opens again', async () => {
    const handle = manager().register(contextDefaultFlow('shortText'));
    const first = handle.open({ context: { name: 'Alice' } });
    await vi.waitFor(() =>
      expect(shadow().querySelector('.bdf-progress')?.textContent).toBe('Step 1 of 2')
    );
    first.close();
    const second = handle.open({ context: { name: 'Bob' } });
    await vi.waitFor(() => expect(shadow().querySelector('input')?.value).toBe('Bob'));
    expect(shadow().querySelector('.bdf-progress')?.textContent).toBe('Step 1 of 1');
    expect(button('Submit')).toBeDefined();
    second.close();
  });
});
