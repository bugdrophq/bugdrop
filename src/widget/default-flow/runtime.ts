import type {
  DefaultDefinition,
  DefaultDetailsStep,
  DefaultPreflightRecipe,
  DefaultScreenshotStep,
  DefaultSubmissionRecipe,
  DefaultWelcomeStep,
} from './definition';
import { FlowRuntime } from '../flows/runtime';

type DefaultPreflightResult =
  { status: 'installed' } | { status: 'not_installed' | 'unreachable'; appName?: string };

export interface DefaultJourneyPorts<Details, Capture> {
  preflight: (recipe: DefaultPreflightRecipe) => Promise<DefaultPreflightResult>;
  showPreflightFailure: (result: Exclude<DefaultPreflightResult, { status: 'installed' }>) => void;
  showWelcome: (step: DefaultWelcomeStep) => Promise<boolean>;
  rememberWelcome: (step: DefaultWelcomeStep) => void;
  showDetails: (step: DefaultDetailsStep, previous: Details | null) => Promise<Details | null>;
  capture: (
    step: DefaultScreenshotStep,
    details: Details
  ) => Promise<Capture & { returnToDetails: boolean }>;
  submit: (recipe: DefaultSubmissionRecipe, details: Details, capture: Capture) => Promise<void>;
}

export async function runDefaultJourney<Details, Capture>(
  definition: DefaultDefinition,
  ports: DefaultJourneyPorts<Details, Capture>,
  signal?: AbortSignal
): Promise<'finished' | 'preflight-blocked'> {
  const preflight = await ports.preflight(definition.system.preflight);
  if (signal?.aborted) return 'finished';
  if (preflight.status !== 'installed') {
    ports.showPreflightFailure(preflight);
    return 'preflight-blocked';
  }

  const welcome = definition.steps[0];
  const runtime = new FlowRuntime(definition.flow, { 'show-welcome': welcome.enabled });
  if (runtime.current()?.id === 'welcome') {
    const continued = await ports.showWelcome(welcome);
    if (signal?.aborted || !continued) return 'finished';
    if (welcome.remember) ports.rememberWelcome(welcome);
    runtime.next();
  }

  const detailsStep = definition.steps[1];
  const screenshotStep = definition.steps[2];
  let details: Details | null = null;
  while (true) {
    if (runtime.current()?.id !== 'details')
      throw new Error('Default flow expected details screen');
    details = await ports.showDetails(detailsStep, details);
    if (signal?.aborted || !details) return 'finished';

    runtime.next();
    if (runtime.current()?.id !== 'screenshot')
      throw new Error('Default flow expected screenshot screen');
    const capture = await ports.capture(screenshotStep, details);
    if (signal?.aborted) return 'finished';
    if (capture.returnToDetails) {
      runtime.back();
      continue;
    }

    await ports.submit(definition.system.submission, details, capture);
    return 'finished';
  }
}
