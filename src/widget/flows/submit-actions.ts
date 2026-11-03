import type { FormScreen } from './public-types';
import { fail, object, only, scalar, text, validId } from './validation-utils';

export function validateSubmitActions(screen: FormScreen): void {
  if (screen.submitActions === undefined) return;
  if (!Array.isArray(screen.submitActions) || screen.submitActions.length !== 2)
    fail('submitActions must contain two actions');
  if (screen.continueLabel !== undefined)
    fail('submitActions cannot be combined with continueLabel');
  const labels = new Set<string>();
  for (const action of screen.submitActions) {
    if (!object(action)) fail('submit action must be an object');
    only(action, new Set(['label', 'metadata']), 'submit action');
    text(action.label, 'submit action label', 120);
    if (labels.has(action.label.trim())) fail('submit action labels must be distinct');
    labels.add(action.label.trim());
    if (!object(action.metadata)) fail('submit action metadata must be an object');
    const entries = Object.entries(action.metadata);
    if (entries.length < 1 || entries.length > 8) fail('submit action metadata needs 1-8 entries');
    for (const [key, value] of entries) {
      validId(key, 'submit action metadata key');
      scalar(value, 'submit action metadata value');
      if (typeof value === 'string' && value.length > 2_000)
        fail('submit action metadata string is too long');
    }
  }
}
