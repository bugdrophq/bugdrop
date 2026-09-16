import type { ManagedConsumerEnv } from './consumer-env';
export default {
  async queue(batch: MessageBatch<unknown>): Promise<void> {
    // Returning successfully without retry would acknowledge and silently lose these events.
    // Do not inspect, log, persist, or acknowledge bodies before the allowlisted writer exists.
    batch.retryAll({ delaySeconds: 60 });
  },
} satisfies ExportedHandler<ManagedConsumerEnv>;
