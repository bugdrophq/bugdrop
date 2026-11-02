// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlowManager } from '../src/widget/flows/manager';
import { validateAndFreezeFlowConfig } from '../src/widget/flows/validate-config';
import type { FlowConfig } from '../src/widget/flows/public-types';

function config(): FlowConfig {
  return {
    configVersion: 1,
    id: 'permission-test',
    presentation: { kind: 'modal' },
    forms: [
      {
        id: 'credit',
        title: 'Can we share?',
        fields: [{ id: 'name', type: 'shortText', label: 'Name', required: true }],
      },
    ],
    screens: [
      {
        id: 'sharing',
        type: 'form',
        form: 'credit',
        submitActions: [
          { label: 'Yes, share', metadata: { permission: true } },
          { label: 'Keep private', metadata: { permission: false } },
        ],
      },
    ],
    issue: {
      title: 'Permission test',
      sections: [
        { heading: 'Permission', context: 'permission' },
        { heading: 'Account', context: 'account', when: { context: 'permission', equals: true } },
      ],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function open(fetcher: ReturnType<typeof vi.fn>) {
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
  return manager.register(config()).open({ context: { permission: false, account: 'private-id' } });
}
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
function shadow() {
  return document.querySelector('[data-bugdrop-flow]')!.shadowRoot!;
}

describe('final submit actions', () => {
  for (const permission of [true, false]) {
    it(`sends exactly one Issue with permission ${permission}`, async () => {
      const fetcher = vi.fn().mockResolvedValue(success());
      const opened = open(fetcher);
      await vi.waitFor(() => expect(shadow().querySelector('input')).not.toBeNull());
      const input = shadow().querySelector('input')!;
      input.value = 'Reviewer';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const button = shadow().querySelector<HTMLButtonElement>(
        `[data-submit-action="${permission ? 0 : 1}"]`
      )!;
      button.click();
      button.click();
      await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(fetcher.mock.calls[0][1].body);
      expect(payload.description).toContain(`## Permission\n\n${permission}`);
      expect(payload.description.includes('private-id')).toBe(permission);
      opened.close();
    });
  }

  it('validates before attaching action metadata and retries the chosen action', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(success());
    const opened = open(fetcher);
    await vi.waitFor(() => expect(shadow().querySelector('[data-submit-action]')).not.toBeNull());
    shadow().querySelector<HTMLButtonElement>('[data-submit-action="0"]')!.click();
    await vi.waitFor(() => expect(shadow().querySelector('.bdv-error')).not.toBeNull());
    expect(fetcher).not.toHaveBeenCalled();
    shadow().querySelector<HTMLInputElement>('input')!.value = 'Reviewer';
    shadow().querySelector<HTMLButtonElement>('[data-submit-action="1"]')!.click();
    await vi.waitFor(() => expect(shadow().textContent).toContain('Submission failed'));
    shadow().querySelector<HTMLButtonElement>('.bdv-submit')!.click();
    await expect(opened.result).resolves.toMatchObject({ status: 'submitted' });
    for (const [, request] of fetcher.mock.calls)
      expect(JSON.parse(request.body).description).toContain('## Permission\n\nfalse');
    opened.close();
  });

  it('closing without choosing an action sends nothing', async () => {
    const fetcher = vi.fn();
    const opened = open(fetcher);
    opened.close();
    await expect(opened.result).resolves.toEqual({ status: 'closed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects nonfinal actions, nonscalar metadata, duplicate labels, and invalid preview paths', () => {
    const nonfinal = config();
    nonfinal.screens.push({ id: 'later', type: 'message', title: 'Later' });
    expect(() => validateAndFreezeFlowConfig(nonfinal)).toThrow('last configured screen');
    const invalid = config();
    (invalid.screens[0] as never as { submitActions: unknown[] }).submitActions = [
      { label: 'Yes', metadata: { permission: [] } },
      { label: 'No', metadata: { permission: false } },
    ];
    expect(() => validateAndFreezeFlowConfig(invalid)).toThrow('must be scalar');
    const duplicate = config();
    if (duplicate.screens[0].type === 'form')
      duplicate.screens[0].submitActions![1].label = 'Yes, share';
    expect(() => validateAndFreezeFlowConfig(duplicate)).toThrow('distinct');
    const preview = config();
    if (preview.screens[0].type === 'form') preview.screens[0].quotePreview = ['credit.name'];
    expect(() => validateAndFreezeFlowConfig(preview)).toThrow('text field');
  });
});
