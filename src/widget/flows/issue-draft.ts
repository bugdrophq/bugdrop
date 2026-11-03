import type { FlowConfig, FlowIssueSection, FlowScalar } from './public-types';

interface FlowIssueDraft {
  title: string;
  description: string;
  category: 'bug' | 'feature' | 'question';
}

export function compileFlowIssueDraft(
  config: Readonly<FlowConfig>,
  answers: Readonly<Record<string, unknown>>,
  context: Readonly<Record<string, FlowScalar>>
): FlowIssueDraft {
  const title = interpolate(config.issue.title, answers).trim().slice(0, 256);
  if (!title) throw new TypeError('BugDrop flow Issue title cannot be empty');
  const sections = (config.issue.sections ?? [])
    .map(section => compileSection(config, section, answers, context))
    .filter((value): value is string => value !== null);
  return {
    title,
    description: sections.join('\n\n'),
    category: config.issue.classification ?? 'bug',
  };
}

function interpolate(template: string, answers: Readonly<Record<string, unknown>>): string {
  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_, path: string) =>
    stringify(answers[path.trim()])
  );
}

function compileSection(
  config: Readonly<FlowConfig>,
  section: FlowIssueSection,
  answers: Readonly<Record<string, unknown>>,
  context: Readonly<Record<string, FlowScalar>>
): string | null {
  const value = 'answer' in section ? answers[section.answer] : context[section.context];
  if (section.omitWhenEmpty && (value === undefined || value === null || value === '')) return null;
  const rendered = formatValue(config, section, value);
  return `## ${section.heading}\n\n${rendered}`;
}

function formatValue(
  config: Readonly<FlowConfig>,
  section: FlowIssueSection,
  value: unknown
): string {
  const format = section.format;
  const rendered = stringify(value);
  if (format === 'quote')
    return rendered
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n');
  if (format === 'code') return formatInlineCode(rendered);
  if (format === 'stars' && typeof value === 'number' && 'answer' in section) {
    const field = findField(config, section.answer);
    const scale = field?.type === 'rating' ? (field.scale ?? 5) : 5;
    return `${'★'.repeat(value)}${'☆'.repeat(Math.max(0, scale - value))} (${value}/${scale})`;
  }
  if (format === 'choice' && typeof value === 'string' && 'answer' in section) {
    const field = findField(config, section.answer);
    if (field?.type === 'singleChoice')
      return field.options.find(option => option.value === value)?.label ?? rendered;
  }
  return rendered;
}

function formatInlineCode(value: string): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
  const delimiter = '`'.repeat(longestRun + 1);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

function findField(config: Readonly<FlowConfig>, path: string) {
  const separator = path.indexOf('.');
  const formId = path.slice(0, separator);
  const fieldId = path.slice(separator + 1);
  return config.forms.find(form => form.id === formId)?.fields.find(field => field.id === fieldId);
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  return String(value);
}
