import { validateScreen, validateCondition } from './screen-validation';
import { validateFlowFieldConfig, validateFlowShell } from './field-validation';
import type { FlowConfig, FlowField, FlowIssueSection } from './public-types';
import { deepFreeze, fail, object, only, optionalText, text, validId } from './validation-utils';
const PATH = /^([a-z][a-z0-9_-]{0,63})\.([a-z][a-z0-9_-]{0,63})$/;
const TOP_KEYS = new Set([
  'configVersion',
  'id',
  'presentation',
  'appearance',
  'content',
  'forms',
  'screens',
  'issue',
  'evidence',
]);
const BASE_FIELD_KEYS = ['id', 'type', 'label', 'helpText', 'required', 'layout'];
const FIELD_KEYS: Record<FlowField['type'], Set<string>> = {
  shortText: new Set([
    ...BASE_FIELD_KEYS,
    'placeholder',
    'minLength',
    'maxLength',
    'prefillFromContext',
  ]),
  longText: new Set([
    ...BASE_FIELD_KEYS,
    'placeholder',
    'rows',
    'minLength',
    'maxLength',
    'prefillFromContext',
  ]),
  rating: new Set([...BASE_FIELD_KEYS, 'scale', 'icon', 'lowLabel', 'highLabel']),
  singleChoice: new Set([...BASE_FIELD_KEYS, 'options', 'display']),
  checkbox: new Set([...BASE_FIELD_KEYS, 'initialValue']),
  attachments: new Set([...BASE_FIELD_KEYS, 'maxFiles', 'maxFileSize', 'accept']),
};
export function validateAndFreezeFlowConfig(input: FlowConfig): Readonly<FlowConfig> {
  if (!object(input)) fail('config must be an object');
  only(input, TOP_KEYS, 'config');
  if (input.configVersion !== 1) fail('configVersion must be 1');
  validId(input.id, 'id');
  validateFlowShell(input);
  if (!Array.isArray(input.forms) || input.forms.length === 0 || input.forms.length > 12) {
    fail('forms must contain 1-12 entries');
  }
  if (!Array.isArray(input.screens) || input.screens.length === 0 || input.screens.length > 20) {
    fail('screens must contain 1-20 entries');
  }

  const answerFields = new Map<string, FlowField>();
  const forms = new Map<string, FlowConfig['forms'][number]>();
  for (const form of input.forms) validateForm(form, forms, answerFields);
  const referencedForms = new Set<string>();
  const guaranteedRequiredAnswers = new Set<string>();
  const earlierAnswers = new Map<string, FlowField>();
  let screenshots = 0;
  const screenIds = new Set<string>();
  for (const screen of input.screens) {
    validateScreen(screen, screenIds, forms, earlierAnswers);
    if (screen.type === 'form' && screen.submitActions && screen !== input.screens.at(-1))
      fail('submitActions must belong to the last configured screen');
    if (screen.type === 'form') {
      if (referencedForms.has(screen.form)) fail(`form ${screen.form} may be referenced only once`);
      referencedForms.add(screen.form);
      for (const field of forms.get(screen.form)!.fields)
        earlierAnswers.set(`${screen.form}.${field.id}`, field);
      if (screen.when === undefined)
        for (const field of forms.get(screen.form)!.fields)
          if (field.required) guaranteedRequiredAnswers.add(`${screen.form}.${field.id}`);
    }
    if (screen.type === 'screenshot' && ++screenshots > 1)
      fail('only one screenshot screen is supported');
  }
  for (const formId of forms.keys())
    if (!referencedForms.has(formId)) fail(`form ${formId} is unused`);
  if (input.screens.every(screen => screen.when !== undefined))
    fail('at least one screen must be unconditional');
  validateIssue(input.issue, answerFields, guaranteedRequiredAnswers);
  validateEvidence(input.evidence, answerFields);
  return deepFreeze(structuredClone(input));
}

function validateForm(
  form: FlowConfig['forms'][number],
  forms: Map<string, FlowConfig['forms'][number]>,
  answerFields: Map<string, FlowField>
) {
  if (!object(form)) fail('form must be an object');
  only(form, new Set(['id', 'title', 'description', 'fields']), 'form');
  validId(form.id, 'form id');
  if (forms.has(form.id)) fail(`duplicate form id ${form.id}`);
  text(form.title, 'form title', 500);
  optionalText(form.description, 'form description', 2_000);
  if (!Array.isArray(form.fields) || form.fields.length === 0 || form.fields.length > 20)
    fail('form fields must contain 1-20 entries');
  const ids = new Set<string>();
  for (const field of form.fields) {
    if (!object(field) || typeof field.type !== 'string' || !(field.type in FIELD_KEYS))
      fail('field type is unsupported');
    only(field, FIELD_KEYS[field.type as FlowField['type']], 'field');
    validId(field.id, 'field id');
    if (ids.has(field.id)) fail(`duplicate field id ${field.id}`);
    ids.add(field.id);
    text(field.label, 'field label', 500);
    optionalText(field.helpText, 'field helpText', 1_000);
    if (field.required !== undefined && typeof field.required !== 'boolean')
      fail('field required must be boolean');
    validateFlowFieldConfig(field as FlowField);
    if ('prefillFromContext' in field)
      validId(field.prefillFromContext, 'field prefillFromContext');
    answerFields.set(`${form.id}.${field.id}`, field as FlowField);
  }
  forms.set(form.id, form);
}

function validateIssue(
  issue: FlowConfig['issue'],
  answers: Map<string, FlowField>,
  guaranteedRequiredAnswers: ReadonlySet<string>
) {
  if (!object(issue)) fail('issue must be an object');
  only(issue, new Set(['classification', 'title', 'sections']), 'issue');
  text(issue.title, 'issue title', 2_000);
  if (
    issue.classification !== undefined &&
    !['bug', 'feature', 'question'].includes(issue.classification)
  )
    fail('issue classification is invalid');
  validateIssueTitleTemplate(issue.title, answers, guaranteedRequiredAnswers);
  if (issue.sections !== undefined) {
    if (!Array.isArray(issue.sections) || issue.sections.length > 20)
      fail('issue sections are invalid');
    const headings = new Set<string>();
    for (const section of issue.sections) validateSection(section, answers, headings);
  }
}

function validateSection(
  section: FlowIssueSection,
  answers: Map<string, FlowField>,
  headings: Set<string>
) {
  if (!object(section)) fail('issue section must be an object');
  if ('answer' in section) {
    only(
      section,
      new Set(['heading', 'answer', 'format', 'omitWhenEmpty', 'when']),
      'issue section'
    );
    validateScalarAnswer(section.answer, answers, 'issue section');
  } else {
    only(
      section,
      new Set(['heading', 'context', 'format', 'omitWhenEmpty', 'when']),
      'issue section'
    );
    validId(section.context, 'issue context');
  }
  text(section.heading, 'issue section heading', 120);
  if (section.when !== undefined) validateCondition(section.when, answers);
  const heading = section.heading.trim().toLowerCase();
  if (headings.has(heading)) fail(`duplicate issue section heading ${section.heading}`);
  headings.add(heading);
  if (section.omitWhenEmpty !== undefined && typeof section.omitWhenEmpty !== 'boolean')
    fail('issue section omitWhenEmpty must be boolean');
  const format = section.format ?? 'text';
  if ('answer' in section) {
    if (!['text', 'quote', 'stars', 'choice', 'code'].includes(format))
      fail('issue answer format is invalid');
    const field = answers.get(section.answer)!;
    if (format === 'stars' && field.type !== 'rating') fail('stars format requires a rating field');
    if (format === 'choice' && field.type !== 'singleChoice')
      fail('choice format requires a singleChoice field');
  } else if (!['text', 'code'].includes(format)) fail('issue context format is invalid');
}

function validateEvidence(evidence: FlowConfig['evidence'], answers: Map<string, FlowField>) {
  if (evidence === undefined) return;
  if (!object(evidence)) fail('evidence must be an object');
  only(evidence, new Set(['attachments', 'sendConsoleLogs', 'submitter']), 'evidence');
  typedPath(evidence.attachments, 'attachments', answers, 'attachments');
  typedPath(evidence.sendConsoleLogs, 'checkbox', answers, 'sendConsoleLogs');
  if (evidence.submitter !== undefined) {
    if (!object(evidence.submitter)) fail('evidence submitter must be an object');
    only(evidence.submitter, new Set(['name', 'email']), 'evidence submitter');
    if (!evidence.submitter.name && !evidence.submitter.email)
      fail('evidence submitter must map name or email');
    if (evidence.submitter.name)
      validateTextAnswer(evidence.submitter.name, answers, 'submitter name');
    if (evidence.submitter.email)
      validateTextAnswer(evidence.submitter.email, answers, 'submitter email');
  }
}
function typedPath(
  path: string | undefined,
  type: FlowField['type'],
  answers: Map<string, FlowField>,
  label: string
) {
  if (path !== undefined && answers.get(path)?.type !== type)
    fail(`${label} must reference a ${type} field`);
}
function validateScalarAnswer(path: string, answers: Map<string, FlowField>, label: string) {
  if (!PATH.test(path) || !answers.has(path) || answers.get(path)?.type === 'attachments')
    fail(`${label} references an unknown scalar answer: ${path}`);
}
function validateTextAnswer(path: string, answers: Map<string, FlowField>, label: string) {
  const type = answers.get(path)?.type;
  if (!PATH.test(path) || (type !== 'shortText' && type !== 'longText'))
    fail(`${label} must reference a text field`);
}
function validateIssueTitleTemplate(
  template: string,
  answers: Map<string, FlowField>,
  guaranteedRequiredAnswers: ReadonlySet<string>
) {
  let cursor = 0;
  let hasRequiredSource = false;
  let literal = '';
  for (const match of template.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
    const index = match.index!;
    const before = template.slice(cursor, index);
    literal += before;
    if (before.includes('{{') || before.includes('}}') || before.endsWith('{'))
      fail('issue title template is malformed');
    const path = match[1]!.trim();
    validateScalarAnswer(path, answers, 'issue title');
    hasRequiredSource ||= guaranteedRequiredAnswers.has(path);
    cursor = index + match[0].length;
    if (template[cursor] === '}') fail('issue title template is malformed');
  }
  const after = template.slice(cursor);
  if (after.includes('{{') || after.includes('}}')) fail('issue title template is malformed');
  literal += after;
  if (!literal.trim() && !hasRequiredSource)
    fail('issue title must contain text or reference a required answer');
}
