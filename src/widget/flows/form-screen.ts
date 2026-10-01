import { normalizeVariantAnswers, VariantAnswerError } from '../variants/answer-validation';
import { createFieldController } from '../variants/fields';
import type { FieldController } from '../variants/fields/types';
import type { VariantField } from '../variants/public-types';
import { PREFILL_EMAIL_LIMIT, PREFILL_NAME_LIMIT } from '../prefill';
import {
  createAttachmentsController,
  createCheckboxController,
  type ExtraFieldController,
} from './extra-fields';
import type { FlowField, FlowForm } from './public-types';

export interface FlowFormController {
  readonly element: HTMLElement;
  collect(): Promise<Record<string, unknown> | null>;
  snapshot(): Promise<Record<string, unknown> | null>;
  dispose(): void;
}

export function createFlowFormScreen(
  formConfig: Readonly<FlowForm>,
  instanceId: string,
  answers: Readonly<Record<string, unknown>>,
  submitterPaths?: Readonly<{ name?: string; email?: string }>
): FlowFormController {
  const formFields = formConfig.fields.map(field => {
    if (field.type !== 'shortText' && field.type !== 'longText') return field;
    const path = `${formConfig.id}.${field.id}`;
    const limit = Math.min(
      path === submitterPaths?.name ? PREFILL_NAME_LIMIT : Infinity,
      path === submitterPaths?.email ? PREFILL_EMAIL_LIMIT : Infinity
    );
    if (!Number.isFinite(limit)) return field;
    return {
      ...field,
      maxLength: Math.min(field.maxLength ?? (field.type === 'shortText' ? 500 : 5_000), limit),
    };
  });
  const section = createSurface(formConfig);
  const fields = document.createElement('div');
  fields.className = 'bdv-fields';
  section.appendChild(fields);
  const controllers = formFields.map(field =>
    createController(field, formConfig.id, instanceId, answers)
  );
  for (const controller of controllers) fields.appendChild(controller.element);

  const read = async (validate: boolean): Promise<Record<string, unknown> | null> => {
    const standard = controllers.filter(isStandardController);
    for (const controller of standard) controller.setError(null);
    let values = Object.fromEntries(
      standard.map(controller => [controller.field.id, controller.getValue()])
    );
    if (validate) {
      try {
        values = normalizeVariantAnswers(formFields.filter(isStandardField), values);
      } catch (error) {
        showStandardError(error, standard);
        return null;
      }
    }
    for (const controller of controllers.filter(isExtraController)) {
      controller.setRequiredError(false);
      const readResult = await controller.read(validate);
      if (!readResult.ok) {
        controller.focus();
        return null;
      }
      if (
        validate &&
        controller.required &&
        (readResult.value === false ||
          (Array.isArray(readResult.value) && readResult.value.length === 0))
      ) {
        controller.setRequiredError(true);
        controller.focus();
        return null;
      }
      values[controller.id] = readResult.value;
    }
    return values;
  };

  return {
    element: section,
    collect: () => read(true),
    snapshot: () => read(false),
    dispose() {
      for (const controller of controllers) controller.dispose();
    },
  };
}

type Controller = FieldController | ExtraFieldController;

function createController(
  field: Readonly<FlowField>,
  formId: string,
  instanceId: string,
  answers: Readonly<Record<string, unknown>>
): Controller {
  if (field.type === 'checkbox') {
    return createCheckboxController(field, formId, instanceId, answers);
  }
  if (field.type === 'attachments') {
    return createAttachmentsController(field, formId, instanceId, answers);
  }
  const controller = createFieldController(field, instanceId);
  controller.setValue(answers[`${formId}.${field.id}`] ?? '');
  return controller;
}

function createSurface(formConfig: Readonly<FlowForm>): HTMLElement {
  const section = document.createElement('section');
  section.className = 'bdv-surface';
  const header = document.createElement('div');
  header.className = 'bdv-header';
  const title = document.createElement('h2');
  title.className = 'bdv-title';
  title.textContent = formConfig.title;
  header.appendChild(title);
  if (formConfig.description) {
    const description = document.createElement('p');
    description.className = 'bdv-description';
    description.textContent = formConfig.description;
    header.appendChild(description);
  }
  section.appendChild(header);
  return section;
}

function showStandardError(error: unknown, controllers: FieldController[]): void {
  const target =
    error instanceof VariantAnswerError
      ? controllers.find(controller => controller.field.id === error.fieldId)
      : undefined;
  target?.setError(
    error instanceof Error ? error.message.replace(/^Answer \S+ /, '') : 'Invalid answer'
  );
  target?.focus();
}

function isStandardField(field: Readonly<FlowField>): field is VariantField {
  return field.type !== 'checkbox' && field.type !== 'attachments';
}
function isStandardController(controller: Controller): controller is FieldController {
  return 'field' in controller;
}
function isExtraController(controller: Controller): controller is ExtraFieldController {
  return 'read' in controller;
}
