// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { normalizeFlowDefinition } from '../src/widget/flows/definition';
import { normalizeFlowOpenOptions } from '../src/widget/flows/field-validation';
import { createFlowFormScreen } from '../src/widget/flows/form-screen';
import { compileFlowIssueDraft } from '../src/widget/flows/issue-draft';
import { FlowRuntime } from '../src/widget/flows/runtime';
import { validateAndFreezeFlowConfig } from '../src/widget/flows/validate-config';
import type { FlowConfig } from '../src/widget/flows/public-types';

const config: FlowConfig = {
  configVersion: 1,
  id: 'name-prefill',
  presentation: { kind: 'modal' },
  forms: [
    {
      id: 'rating',
      title: 'Rating',
      fields: [{ id: 'stars', type: 'rating', label: 'Stars', required: true }],
    },
    {
      id: 'sharing',
      title: 'Sharing',
      fields: [
        {
          id: 'credit',
          type: 'shortText',
          label: 'Credit',
          maxLength: 80,
          prefillFromContext: 'account-name',
        },
      ],
    },
  ],
  screens: [
    { id: 'rating-screen', type: 'form', form: 'rating' },
    {
      id: 'sharing-screen',
      type: 'form',
      form: 'sharing',
      when: { answer: 'rating.stars', equals: 5 },
    },
  ],
  issue: {
    title: 'Test feedback',
    sections: [{ heading: 'Credit', answer: 'sharing.credit', omitWhenEmpty: true }],
  },
};

describe('per-open text defaults', () => {
  it('applies the current account name only when the conditional form opens', () => {
    const definition = normalizeFlowDefinition(validateAndFreezeFlowConfig(config));
    const options = normalizeFlowOpenOptions(definition, {
      context: { 'account-name': 'Reviewer A' },
    });
    const runtime = new FlowRuntime(definition, options.context);
    expect(runtime.answers['sharing.credit']).toBeUndefined();
    expect(
      compileFlowIssueDraft(config, runtime.answers, runtime.context).description
    ).not.toContain('Reviewer A');
    runtime.setFormAnswers('rating', { stars: 5 });
    runtime.next();
    const form = createFlowFormScreen(
      config.forms[1],
      'prefill',
      runtime.answers,
      undefined,
      runtime.context
    );
    expect(form.element.querySelector('input')!.value).toBe('Reviewer A');
    form.dispose();
    const other = createFlowFormScreen(config.forms[1], 'other', {}, undefined, {
      'account-name': 'Reviewer B',
    });
    expect(other.element.querySelector('input')!.value).toBe('Reviewer B');
    other.dispose();
  });

  for (const edited of ['My public handle', '']) {
    it(`preserves an explicit edit or clear (${JSON.stringify(edited)})`, async () => {
      const form = createFlowFormScreen(config.forms[1], 'edit', {}, undefined, {
        'account-name': 'Original name',
      });
      form.element.querySelector('input')!.value = edited;
      const answers = await form.collect();
      form.dispose();
      const revisited = createFlowFormScreen(
        config.forms[1],
        'back',
        { 'sharing.credit': answers!.credit },
        undefined,
        { 'account-name': 'Original name' }
      );
      expect(revisited.element.querySelector('input')!.value).toBe(edited);
      revisited.dispose();
    });
  }

  it('bounds defaults to the text field limit and ignores non-text context', () => {
    const form = createFlowFormScreen(config.forms[1], 'bounded', {}, undefined, {
      'account-name': 'A'.repeat(100),
    });
    expect(form.element.querySelector('input')!.value).toHaveLength(80);
    form.dispose();
    const invalid = createFlowFormScreen(config.forms[1], 'invalid', {}, undefined, {
      'account-name': 123,
    });
    expect(invalid.element.querySelector('input')!.value).toBe('');
    invalid.dispose();
  });
});
