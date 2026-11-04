import type { FlowConfig } from '../../src/widget/flows/public-types';

/** Records a preference only; the application owns contact collection and follow-up. */
export const replyPreferenceFlow: FlowConfig = {
  configVersion: 1,
  id: 'reply-preference',
  presentation: { kind: 'modal' },
  forms: [
    {
      id: 'feedback',
      title: 'Send product feedback',
      fields: [{ id: 'summary', type: 'shortText', label: 'Feedback', required: true }],
    },
  ],
  screens: [
    {
      id: 'feedback-screen',
      type: 'form',
      form: 'feedback',
      submitActions: [
        { label: 'Record reply requested', metadata: { 'reply-preference': 'reply' } },
        { label: 'Just send feedback', metadata: { 'reply-preference': 'no-reply' } },
      ],
    },
  ],
  issue: {
    title: 'Product feedback',
    sections: [
      { heading: 'Feedback', answer: 'feedback.summary' },
      { heading: 'Reply preference', context: 'reply-preference' },
    ],
  },
};
