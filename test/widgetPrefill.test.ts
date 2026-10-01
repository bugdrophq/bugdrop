import { describe, expect, it, vi } from 'vitest';
import {
  getPrefill,
  PREFILL_EMAIL_LIMIT,
  PREFILL_NAME_LIMIT,
  PREFILL_TEMPLATE_LIMIT,
} from '../src/widget/prefill';

const globals = (values: Record<string, unknown>) => values as Window & Record<string, unknown>;

describe('widget prefill provider', () => {
  it('reads a fresh synchronous snapshot and keeps only supported fields', () => {
    let name = 'First';
    const provider = vi.fn(() => ({
      name,
      email: 'first@example.com',
      descriptionTemplates: { bug: '<b>literal</b>', feature: 'Feature', other: 'ignored' },
      ignored: 'ignored',
    }));
    const globalObject = globals({ getDefaults: provider });
    expect(getPrefill('getDefaults', globalObject)).toEqual({
      name: 'First',
      email: 'first@example.com',
      descriptionTemplates: { bug: '<b>literal</b>', feature: 'Feature', question: undefined },
    });
    name = 'Second';
    expect(getPrefill('getDefaults', globalObject).name).toBe('Second');
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('ignores missing, throwing, asynchronous, and malformed providers without personal values in warnings', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const globalObject = globals({
      broken: () => {
        throw new Error('sensitive value');
      },
      asyncProvider: () => Promise.resolve({ name: 'sensitive value' }),
      malformed: () => ({ name: 42, email: ['sensitive value'], descriptionTemplates: [] }),
    });
    expect(getPrefill(undefined, globalObject)).toEqual({});
    expect(getPrefill('missing', globalObject)).toEqual({});
    expect(getPrefill('broken', globalObject)).toEqual({});
    expect(getPrefill('asyncProvider', globalObject)).toEqual({});
    expect(getPrefill('malformed', globalObject)).toEqual({
      name: undefined,
      email: undefined,
      descriptionTemplates: {},
    });
    expect(warning.mock.calls.flat().join(' ')).not.toContain('sensitive value');
    warning.mockRestore();
  });

  it('accepts limits and drops overlong fields independently', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = getPrefill(
      'provider',
      globals({
        provider: () => ({
          name: 'n'.repeat(PREFILL_NAME_LIMIT + 1),
          email: `${'e'.repeat(PREFILL_EMAIL_LIMIT - '@x.test'.length)}@x.test`,
          descriptionTemplates: {
            bug: 'b'.repeat(PREFILL_TEMPLATE_LIMIT),
            feature: 'f'.repeat(PREFILL_TEMPLATE_LIMIT + 1),
          },
        }),
      })
    );
    expect(result.name).toBeUndefined();
    expect(result.email).toHaveLength(PREFILL_EMAIL_LIMIT);
    expect(result.descriptionTemplates?.bug).toHaveLength(PREFILL_TEMPLATE_LIMIT);
    expect(result.descriptionTemplates?.feature).toBeUndefined();
    warning.mockRestore();
  });

  it('ignores invalid identity values without dropping valid templates', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = getPrefill(
      'provider',
      globals({
        provider: () => ({
          name: 'spoof\u202evalue',
          email: 'not-an-address',
          descriptionTemplates: { bug: 'Keep this prompt', feature: 'bad\u202evalue' },
        }),
      })
    );
    expect(result).toEqual({
      name: undefined,
      email: undefined,
      descriptionTemplates: { bug: 'Keep this prompt', feature: undefined, question: undefined },
    });
    expect(warning.mock.calls.flat().join(' ')).not.toContain('spoof');
    warning.mockRestore();
  });

  it.each(['a@bad/domain', 'a@a..b'])('ignores an email input would reject: %s', email => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      getPrefill('provider', globals({ provider: () => ({ email, name: 'Keep name' }) }))
    ).toMatchObject({ email: undefined, name: 'Keep name' });
    warning.mockRestore();
  });

  it('preserves independent fields when a provider getter throws', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = getPrefill(
      'provider',
      globals({
        provider: () => ({
          get name() {
            throw new Error('private name');
          },
          email: 'valid@example.com',
          descriptionTemplates: {
            get bug() {
              throw new Error('private prompt');
            },
            feature: 'Preserved',
          },
        }),
      })
    );
    expect(result).toEqual({
      name: undefined,
      email: 'valid@example.com',
      descriptionTemplates: { bug: undefined, feature: 'Preserved', question: undefined },
    });
    expect(warning.mock.calls.flat().join(' ')).not.toContain('private');
    warning.mockRestore();
  });

  it('observes a rejected asynchronous provider without using its values', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      getPrefill(
        'provider',
        globals({ provider: () => Promise.reject(new Error('private rejection')) })
      )
    ).toEqual({});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(warning.mock.calls.flat().join(' ')).not.toContain('private');
    warning.mockRestore();
  });
});
