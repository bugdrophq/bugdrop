import type { FlowConfig } from '../../src/widget/flows/public-types';

/** Uses existing choice, conditional-screen, answer-mapping, and Submit primitives. */
export const publicationFlow: FlowConfig = {
  configVersion: 1,
  id: 'publication-permission',
  presentation: { kind: 'modal' },
  forms: [
    {
      id: 'experience',
      title: 'Your feedback',
      fields: [
        { id: 'rating', type: 'rating', label: 'Rate your experience', required: true },
        { id: 'quote', type: 'longText', label: 'Your blurb', minLength: 5, maxLength: 500 },
      ],
    },
    {
      id: 'permission',
      title: 'Mind if we share your blurb?',
      description: 'Permission covers our website only.',
      fields: [
        {
          id: 'publish',
          type: 'singleChoice',
          label: 'Publication permission',
          required: true,
          options: [
            { value: 'yes', label: 'Yes, you can share this' },
            { value: 'no', label: 'Keep my feedback private' },
          ],
        },
      ],
    },
    {
      id: 'attribution',
      title: 'How should we credit you?',
      fields: [
        {
          id: 'name',
          type: 'shortText',
          label: 'Show my quote as',
          maxLength: 80,
          helpText: 'Edit your name or leave blank for Anonymous.',
          prefillFromContext: 'account-name',
        },
      ],
    },
  ],
  screens: [
    { id: 'experience-screen', type: 'form', form: 'experience' },
    {
      id: 'permission-screen',
      type: 'form',
      form: 'permission',
      when: { answer: 'experience.rating', equals: 5 },
    },
    {
      id: 'attribution-screen',
      type: 'form',
      form: 'attribution',
      when: { answer: 'permission.publish', equals: 'yes' },
    },
  ],
  issue: {
    title: 'Feedback',
    sections: [
      { heading: 'Rating', answer: 'experience.rating', format: 'stars' },
      { heading: 'Quote', answer: 'experience.quote', format: 'quote', omitWhenEmpty: true },
      { heading: 'Publication permission', answer: 'permission.publish', omitWhenEmpty: true },
      { heading: 'Credit', answer: 'attribution.name', omitWhenEmpty: true },
    ],
  },
};
