import type { FlowConfig, FlowHandle, FlowOpenOptions } from './public-types';
import { normalizeFlowDefinition, type FlowDefinition } from './definition';
import { createBusyOpenedFlow } from './busy-opened-flow';
import { openFlowModal, type FlowModalPorts } from './modal';
import { submitFlow, type FlowTransportConfig } from './submission';
import { validateAndFreezeFlowConfig } from './validate-config';
import { normalizeFlowOpenOptions } from './field-validation';

export interface FlowManager {
  register(config: FlowConfig): FlowHandle;
}
export function createFlowManager(
  transport: FlowTransportConfig,
  ports: Pick<FlowModalPorts, 'preflight' | 'capture'>,
  runtime: { isLegacyModalOpen(): boolean } = { isLegacyModalOpen: () => false }
): FlowManager {
  const flows = new Map<string, FlowDefinition>();
  return {
    register(config) {
      const normalized = validateAndFreezeFlowConfig(config);
      if (flows.has(normalized.id))
        throw new TypeError(`BugDrop flow is already registered: ${normalized.id}`);
      const definition = normalizeFlowDefinition(normalized);
      flows.set(normalized.id, definition);
      return Object.freeze({
        id: normalized.id,
        open(options?: FlowOpenOptions) {
          if (runtime.isLegacyModalOpen()) {
            normalizeFlowOpenOptions(definition, options);
            return createBusyOpenedFlow(normalized.id);
          }
          return openFlowModal(definition, options, {
            ...ports,
            submit: flowRuntime =>
              submitFlow(
                transport,
                normalized,
                flowRuntime.answers,
                flowRuntime.context,
                flowRuntime.capture
              ),
          });
        },
      });
    },
  };
}
