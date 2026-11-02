import { countConditionNodes } from './conditions';
import { validateSubmitActions } from './submit-actions';
import { validateFlowConditionValue } from './field-validation';
import type { FlowCondition, FlowConfig, FlowField, FlowScreen } from './public-types';
import { fail, object, only, optionalText, scalar, text, validId } from './validation-utils';

export function validateScreen(
  screen: FlowScreen,
  ids: Set<string>,
  forms: Map<string, FlowConfig['forms'][number]>,
  earlier: Map<string, FlowField>
) {
  if (!object(screen)) fail('screen must be an object');
  validId(screen.id, 'screen id');
  if (ids.has(screen.id)) fail(`duplicate screen id ${screen.id}`);
  ids.add(screen.id);
  if (!['message', 'form', 'screenshot'].includes(screen.type)) fail('screen type is unsupported');
  const keys =
    screen.type === 'message'
      ? new Set(['id', 'type', 'when', 'title', 'description', 'continueLabel'])
      : screen.type === 'form'
        ? new Set([
            'id',
            'type',
            'when',
            'form',
            'continueLabel',
            'backLabel',
            'submitActions',
            'quotePreview',
          ])
        : new Set([
            'id',
            'type',
            'when',
            'title',
            'description',
            'mode',
            'continueLabel',
            'backLabel',
          ]);
  only(screen, keys, 'screen');
  if (Object.prototype.hasOwnProperty.call(screen, 'when'))
    validateCondition(screen.when as FlowCondition, earlier);
  if (screen.type === 'message') {
    text(screen.title, 'message title', 500);
    optionalText(screen.description, 'message description', 2_000);
  }
  if (screen.type === 'form' && !forms.has(screen.form))
    fail(`screen references unknown form ${screen.form}`);
  if (screen.type === 'screenshot' && !['optional', 'auto', 'required'].includes(screen.mode))
    fail('screenshot mode is invalid');
  if (screen.type === 'screenshot') {
    optionalText(screen.title, 'screenshot title', 500);
    optionalText(screen.description, 'screenshot description', 2_000);
  }
  optionalText(screen.continueLabel, 'screen continueLabel', 120);
  if (screen.type !== 'message') optionalText(screen.backLabel, 'screen backLabel', 120);
  if (screen.type === 'form') {
    validateSubmitActions(screen);
    if (screen.quotePreview !== undefined) {
      if (
        !Array.isArray(screen.quotePreview) ||
        screen.quotePreview.length < 1 ||
        screen.quotePreview.length > 3
      )
        fail('quotePreview must contain 1-3 earlier text answers');
      for (const path of screen.quotePreview) {
        const type = earlier.get(path)?.type;
        if (type !== 'shortText' && type !== 'longText')
          fail('quotePreview must reference an earlier text field');
      }
    }
  }
}

export function validateCondition(condition: FlowCondition, earlier: Map<string, FlowField>) {
  if (!object(condition)) fail('condition must be an object');
  countConditionNodes(condition);
  if ('answer' in condition) {
    only(condition, new Set(['answer', 'equals']), 'answer condition');
    const field = earlier.get(condition.answer);
    if (!field) fail(`condition answer must reference an earlier field: ${condition.answer}`);
    scalar(condition.equals, 'condition equals');
    validateFlowConditionValue(field, condition.equals);
    return;
  }
  if ('context' in condition) {
    only(condition, new Set(['context', 'equals']), 'context condition');
    validId(condition.context, 'condition context');
    scalar(condition.equals, 'condition equals');
    return;
  }
  const key = 'all' in condition ? 'all' : 'any' in condition ? 'any' : null;
  if (!key) fail('condition must contain answer, context, all, or any');
  only(condition, new Set([key]), 'condition group');
  const children =
    key === 'all'
      ? (condition as Extract<FlowCondition, { all: FlowCondition[] }>).all
      : (condition as Extract<FlowCondition, { any: FlowCondition[] }>).any;
  if (!Array.isArray(children) || children.length < 1 || children.length > 8)
    fail(`condition ${key} must contain 1-8 entries`);
  for (const child of children) validateCondition(child, earlier);
}
