import type { FlowConfig } from '../../src/widget/flows/public-types';

export function contextDefaultFlow(type: 'shortText' | 'longText'): FlowConfig {
  return {
    configVersion: 1,
    id: `context-default-${type.toLowerCase()}`,
    presentation: { kind: 'modal' },
    forms: [
      {
        id: 'first',
        title: 'Confirm your name',
        fields: [{ id: 'text', type, label: 'Name', prefillFromContext: 'name' }],
      },
      {
        id: 'second',
        title: 'Follow-up for Alice',
        fields: [{ id: 'response', type: 'shortText', label: 'Response', required: true }],
      },
    ],
    screens: [
      { id: 'first-screen', type: 'form', form: 'first' },
      {
        id: 'second-screen',
        type: 'form',
        form: 'second',
        when: { answer: 'first.text', equals: 'Alice' },
      },
    ],
    issue: {
      title: 'Context default routing',
      sections: [
        { heading: 'Name', answer: 'first.text' },
        { heading: 'Response', answer: 'second.response', omitWhenEmpty: true },
      ],
    },
  };
}
