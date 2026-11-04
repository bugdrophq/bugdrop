import type { FlowConfig } from '../../src/widget/flows/public-types';

/** Five-star permission is collected by the final two submit buttons. */
export const publicationFlow: FlowConfig = {
  configVersion: 1,
  id: 'publication-permission',
  presentation: { kind: 'modal', size: 'compact' },
  appearance: { theme: 'light', accentColor: '#e53935', density: 'comfortable' },
  content: { successTitle: 'Thanks for the feedback!', successMessage: 'We got your feedback.' },
  forms: [
    {
      id: 'experience',
      title: "How's Bleep treating you?",
      description: 'Tell us about your Bleep experience.',
      fields: [
        { id: 'rating', type: 'rating', label: 'How would you rate Bleep?', required: true },
        { id: 'comment', type: 'longText', label: 'Anything to add? (optional)', maxLength: 1000 },
      ],
    },
    {
      id: 'quote',
      title: 'Share a few words',
      description: 'Got a quote about Bleep? This is optional.',
      fields: [
        {
          id: 'text',
          type: 'longText',
          label: 'Your quote (optional)',
          minLength: 5,
          maxLength: 500,
        },
      ],
    },
    {
      id: 'sharing',
      title: 'Help someone else discover Bleep.',
      description: 'Mind if we share your blurb about Bleep?',
      fields: [
        {
          id: 'credit',
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
      id: 'quote-screen',
      type: 'form',
      form: 'quote',
      when: {
        all: [
          { answer: 'experience.rating', equals: 5 },
          { answer: 'experience.comment', equals: '' },
        ],
      },
    },
    {
      id: 'sharing-screen',
      type: 'form',
      form: 'sharing',
      when: { answer: 'experience.rating', equals: 5 },
      quotePreview: ['quote.text', 'experience.comment'],
      submitActions: [
        { label: 'Yes, you can share this', metadata: { 'publication-permission': true } },
        { label: 'Keep my feedback private', metadata: { 'publication-permission': false } },
      ],
    },
  ],
  issue: {
    title: 'Feedback',
    sections: [
      { heading: 'Rating', answer: 'experience.rating', format: 'stars' },
      { heading: 'Comment', answer: 'experience.comment', omitWhenEmpty: true },
      { heading: 'Quote', answer: 'quote.text', format: 'quote', omitWhenEmpty: true },
      { heading: 'Publication permission', context: 'publication-permission' },
      { heading: 'Publication channels', context: 'publication-channels' },
      { heading: 'Credit', answer: 'sharing.credit', omitWhenEmpty: true },
    ],
  },
};
