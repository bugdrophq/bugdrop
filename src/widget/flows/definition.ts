import type { FlowConfig, FlowField, FlowScreen } from './public-types';

export interface FlowDefinition {
  readonly compiler: 'bugdrop-flow@1';
  readonly flowId: string;
  readonly config: Readonly<FlowConfig>;
  readonly fields: ReadonlyMap<string, Readonly<FlowField>>;
  readonly contextKeys: ReadonlySet<string>;
  readonly screenAnswerPaths: ReadonlyMap<string, readonly string[]>;
  readonly screens: readonly Readonly<FlowScreen>[];
}

export function normalizeFlowDefinition(config: Readonly<FlowConfig>): FlowDefinition {
  const fields = new Map<string, Readonly<FlowField>>();
  for (const form of config.forms) {
    for (const field of form.fields) fields.set(`${form.id}.${field.id}`, field);
  }
  const screenAnswerPaths = new Map<string, readonly string[]>();
  const contextKeys = new Set<string>();
  for (const field of fields.values()) {
    if ((field.type === 'shortText' || field.type === 'longText') && field.prefillFromContext)
      contextKeys.add(field.prefillFromContext);
  }
  for (const screen of config.screens) {
    collectConditionContextKeys(screen.when, contextKeys);
    screenAnswerPaths.set(
      screen.id,
      screen.type === 'form'
        ? config.forms
            .find(form => form.id === screen.form)!
            .fields.map(field => `${screen.form}.${field.id}`)
        : []
    );
  }
  for (const section of config.issue.sections ?? []) {
    if ('context' in section) contextKeys.add(section.context);
    collectConditionContextKeys(section.when, contextKeys);
  }
  return Object.freeze({
    compiler: 'bugdrop-flow@1' as const,
    flowId: config.id,
    config,
    fields,
    contextKeys,
    screenAnswerPaths,
    screens: config.screens,
  });
}

function collectConditionContextKeys(condition: FlowScreen['when'], keys: Set<string>): void {
  if (!condition) return;
  if ('context' in condition) keys.add(condition.context);
  else if ('all' in condition)
    condition.all.forEach(child => collectConditionContextKeys(child, keys));
  else if ('any' in condition)
    condition.any.forEach(child => collectConditionContextKeys(child, keys));
}
