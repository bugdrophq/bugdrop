import { injectStyles } from '../ui';
import type { FlowConfig } from './public-types';

interface CaptureView {
  shadow: ShadowRoot;
  progress: string;
  size: NonNullable<FlowConfig['presentation']['size']>;
  appearance: FlowConfig['appearance'];
}

export function createFlowCaptureView(
  view: CaptureView,
  config: Parameters<typeof injectStyles>[1]
): { root: HTMLElement; dispose(): void } {
  const flowRoot = view.shadow.querySelector<HTMLElement>('.bdv-root');
  const theme = flowRoot?.classList.contains('bdv-dark') ? 'dark' : 'light';
  const root = injectStyles(view.shadow, {
    repo: config.repo,
    apiUrl: config.apiUrl,
    position: config.position,
    theme,
    accentColor: view.appearance?.accentColor ?? '#2563eb',
    font: 'inherit',
  });
  const legacyStyle = root.previousElementSibling;
  root.dataset.flowCapture = 'true';
  root.dataset.flowProgress = view.progress;
  root.dataset.flowSize = view.size;
  root.dataset.flowDensity = view.appearance?.density ?? 'comfortable';
  const themeObserver = new MutationObserver(() => {
    root.classList.toggle('bd-dark', flowRoot?.classList.contains('bdv-dark') ?? false);
  });
  if (flowRoot) themeObserver.observe(flowRoot, { attributes: true, attributeFilter: ['class'] });

  const style = document.createElement('style');
  style.textContent = `
    .bd-root[data-flow-capture] {
      --bd-bg-primary: #fff;
      --bd-bg-secondary: #f8fafc;
      --bd-bg-tertiary: #e2e8f0;
      --bd-text-primary: #0f172a;
      --bd-text-secondary: #475569;
      --bd-text-muted: #64748b;
      --bd-border: #cbd5e1;
      --bd-primary-text: #fff;
      --bd-overlay-bg: #0f172a8f;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.5;
    }
    .bd-root[data-flow-capture].bd-dark {
      --bd-bg-primary: #0f172a;
      --bd-bg-secondary: #1e293b;
      --bd-bg-tertiary: #334155;
      --bd-text-primary: #f8fafc;
      --bd-text-secondary: #cbd5e1;
      --bd-text-muted: #94a3b8;
      --bd-border: #475569;
    }
    .bd-root[data-flow-capture] .bd-overlay {
      background: #0f172a8f;
      animation: none;
      padding: max(20px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
        max(20px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      overflow: auto;
      align-items: safe center;
    }
    .bd-root[data-flow-capture] .bd-modal {
      width: 100%;
      max-width: 560px;
      max-height: min(90vh, 900px);
      border: 1px solid var(--bd-border);
      border-radius: 14px;
      box-shadow: 0 8px 28px #0f172a1a;
      animation: none;
    }
    .bd-root[data-flow-size="compact"] .bd-modal { max-width: 440px; }
    .bd-root[data-flow-size="wide"] .bd-modal { max-width: 760px; }
    .bd-root[data-flow-capture] .bd-modal--annotator { max-width: min(1100px, 96vw); }
    .bd-root[data-flow-capture] .bd-header {
      display: block;
      padding: 24px 60px 0;
      border: 0;
      cursor: default;
      touch-action: auto;
      animation: none;
      text-align: center;
    }
    .bd-root[data-flow-capture] .bd-flow-progress {
      margin: 0 0 12px;
      color: var(--bd-text-muted);
      font-size: .8rem;
    }
    .bd-root[data-flow-capture] .bd-title { font-size: 1.25rem; line-height: 1.3; }
    .bd-root[data-flow-capture] .bd-close {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 44px;
      height: 44px;
      border-radius: 999px;
    }
    .bd-root[data-flow-capture] .bd-body { padding: 16px 24px 24px; }
    .bd-root[data-flow-capture] .bd-screenshot-actions { justify-content: center; }
    .bd-root[data-flow-capture] .bd-modal:not(.bd-modal--annotator) .bd-body,
    .bd-root[data-flow-capture] .bd-annotation-notes { text-align: center; }
    .bd-root[data-flow-capture] .bd-tools { justify-content: center; }
    .bd-root[data-flow-density="compact"] .bd-header { padding: 16px 56px 0 16px; }
    .bd-root[data-flow-density="compact"] .bd-body { padding: 14px 16px 16px; }
    .bd-root[data-flow-capture] .bd-body > * { animation: none; }
    .bd-root[data-flow-capture] .bd-btn { min-height: 44px; border-radius: 9px; font: inherit; font-weight: 650; }
    .bd-root[data-flow-capture] .bd-btn-secondary { border: 1px solid var(--bd-border); }
    @media (min-width: 641px) {
      .bd-root[data-flow-capture] .bd-modal--annotator .bd-annotation-stage {
        max-height: min(44vh, 460px);
      }
    }
    @media (max-width: 640px) {
      .bd-root[data-flow-capture] .bd-modal { max-width: none; }
      .bd-root[data-flow-capture] .bd-header { padding: 18px 60px 0; }
      .bd-root[data-flow-capture] .bd-body { padding: 14px 18px 18px; }
    }
  `;
  view.shadow.appendChild(style);

  return {
    root,
    dispose() {
      themeObserver.disconnect();
      root.remove();
      style.remove();
      legacyStyle?.remove();
    },
  };
}
