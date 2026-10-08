import { createStyledVariantRoot } from '../variants/styles';
import type { VariantConfig } from '../variants/public-types';
import type { FlowConfig } from './public-types';

export function createStyledFlowRoot(shadow: ShadowRoot, config: Readonly<FlowConfig>) {
  const adapter: Readonly<VariantConfig> = {
    id: config.id,
    presentation: config.presentation,
    appearance: config.appearance,
    content: { title: config.id },
    fields: [{ id: 'placeholder', type: 'shortText', label: 'Placeholder' }],
    issue: { title: config.id },
  };
  const styled = createStyledVariantRoot(shadow, adapter, 'modal');
  const extra = document.createElement('style');
  extra.textContent = `
    .bdv-overlay[hidden] { display: none; }
    .bdf-progress { margin: 0 0 12px; color: var(--bdv-text-muted); font-size: .8rem; }
    .bdf-message { min-height: 180px; display: grid; align-content: center; }
    .bdf-attachment { display: grid; gap: 7px; }
    .bdf-checkbox { display: flex; min-height: 44px; align-items: center; gap: 10px; }
    .bdf-checkbox input { width: 20px; height: 20px; accent-color: var(--bdv-accent); }
    .bdf-file-list { margin: 0; padding-left: 20px; color: var(--bdv-text-muted); }
    .bdf-back { order: -1; }
    .bdf-transitioning { overflow: hidden; }
    .bdf-transitioning > .bdv-surface { grid-area: 1 / 1; }
    .bdf-slide-forward-enter { animation: bdf-slide-from-right var(--bdf-screen-transition-duration, 500ms) cubic-bezier(.2, .8, .2, 1); }
    .bdf-slide-forward-exit { animation: bdf-slide-to-left var(--bdf-screen-transition-duration, 500ms) cubic-bezier(.2, .8, .2, 1); }
    .bdf-slide-backward-enter { animation: bdf-slide-from-left var(--bdf-screen-transition-duration, 500ms) cubic-bezier(.2, .8, .2, 1); }
    .bdf-slide-backward-exit { animation: bdf-slide-to-right var(--bdf-screen-transition-duration, 500ms) cubic-bezier(.2, .8, .2, 1); }
    .bdf-slide-vertical-forward-enter { animation: bdf-slide-from-bottom var(--bdf-screen-transition-duration, 500ms) cubic-bezier(.2, .8, .2, 1); }
    .bdf-slide-vertical-forward-exit { animation: bdf-slide-to-top var(--bdf-screen-transition-duration, 500ms) cubic-bezier(.2, .8, .2, 1); }
    .bdf-slide-vertical-backward-enter { animation: bdf-slide-from-top var(--bdf-screen-transition-duration, 500ms) cubic-bezier(.2, .8, .2, 1); }
    .bdf-slide-vertical-backward-exit { animation: bdf-slide-to-bottom var(--bdf-screen-transition-duration, 500ms) cubic-bezier(.2, .8, .2, 1); }
    .bdf-fade-enter { animation: bdf-fade-in var(--bdf-screen-transition-duration, 350ms) ease-out; }
    .bdf-fade-exit { animation: bdf-fade-out var(--bdf-screen-transition-duration, 350ms) ease-in; }
    .bdf-scale-fade-enter { animation: bdf-scale-fade-in var(--bdf-screen-transition-duration, 450ms) cubic-bezier(.2, .8, .2, 1); }
    .bdf-scale-fade-exit { animation: bdf-scale-fade-out var(--bdf-screen-transition-duration, 450ms) cubic-bezier(.2, .8, .2, 1); }
    .bdf-custom-enter { animation: bdf-custom-in var(--bdf-screen-transition-duration, 500ms) var(--bdf-screen-transition-easing, ease); }
    .bdf-custom-exit { animation: bdf-custom-out var(--bdf-screen-transition-duration, 500ms) var(--bdf-screen-transition-easing, ease); }
    @keyframes bdf-slide-from-right {
      from { opacity: .35; transform: translateX(24px); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes bdf-slide-to-left {
      from { opacity: 1; transform: translateX(0); }
      to { opacity: 0; transform: translateX(-24px); }
    }
    @keyframes bdf-slide-from-left {
      from { opacity: .35; transform: translateX(-24px); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes bdf-slide-to-right {
      from { opacity: 1; transform: translateX(0); }
      to { opacity: 0; transform: translateX(24px); }
    }
    @keyframes bdf-slide-from-bottom {
      from { opacity: .35; transform: translateY(24px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes bdf-slide-to-top {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(-24px); }
    }
    @keyframes bdf-slide-from-top {
      from { opacity: .35; transform: translateY(-24px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes bdf-slide-to-bottom {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(24px); }
    }
    @keyframes bdf-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes bdf-fade-out { from { opacity: 1; } to { opacity: 0; } }
    @keyframes bdf-scale-fade-in {
      from { opacity: 0; transform: scale(.96); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes bdf-scale-fade-out {
      from { opacity: 1; transform: scale(1); }
      to { opacity: 0; transform: scale(1.025); }
    }
    @keyframes bdf-custom-in {
      from {
        opacity: var(--bdf-custom-enter-opacity, 1);
        transform: translate3d(var(--bdf-custom-enter-x, 0), var(--bdf-custom-enter-y, 0), 0) scale(var(--bdf-custom-enter-scale, 1));
      }
      to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
    }
    @keyframes bdf-custom-out {
      from { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
      to {
        opacity: var(--bdf-custom-exit-opacity, 1);
        transform: translate3d(var(--bdf-custom-exit-x, 0), var(--bdf-custom-exit-y, 0), 0) scale(var(--bdf-custom-exit-scale, 1));
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .bdf-slide-forward-enter, .bdf-slide-forward-exit,
      .bdf-slide-backward-enter, .bdf-slide-backward-exit,
      .bdf-slide-vertical-forward-enter, .bdf-slide-vertical-forward-exit,
      .bdf-slide-vertical-backward-enter, .bdf-slide-vertical-backward-exit,
      .bdf-fade-enter, .bdf-fade-exit,
      .bdf-scale-fade-enter, .bdf-scale-fade-exit,
      .bdf-custom-enter, .bdf-custom-exit { animation: none; }
    }
  `;
  shadow.prepend(extra);
  return {
    root: styled.root,
    dispose() {
      extra.remove();
      styled.dispose();
    },
  };
}
