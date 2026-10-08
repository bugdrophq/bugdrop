type ModalState = {
  container: HTMLElement;
  owner: HTMLElement;
  opener: HTMLElement | null;
  overflow: string;
  overflowPriority: string;
  ownsScrollLock: boolean;
  inertBefore: Map<HTMLElement, boolean>;
  overlays: HTMLElement[];
  observer: MutationObserver;
  finishTimer: number | null;
  onKeydown: (event: KeyboardEvent) => void;
};

const modalStates = new WeakMap<HTMLElement, ModalState>();
const flowModalStates = new Set<ModalState>();
const focusableSelector =
  'button:not(:disabled), input:not(:disabled):not([type="hidden"]):not([type="file"]), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function manageLegacyModal(container: HTMLElement, overlay: HTMLElement): void {
  let state = modalStates.get(container);
  if (!state) {
    state = createState(container);
    modalStates.set(container, state);
  }
  if (state.finishTimer !== null) {
    window.clearTimeout(state.finishTimer);
    state.finishTimer = null;
  }
  state.overlays.push(overlay);
  updateBackground(state);

  queueMicrotask(() => {
    if (!overlay.isConnected || state.overlays.at(-1) !== overlay) return;
    const dialog = overlay.querySelector<HTMLElement>('.bd-modal');
    const titleInput = dialog?.querySelector<HTMLElement>('#title');
    const preferred = Array.from(
      dialog?.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]):not([type="file"]), textarea, select, [data-action="continue"]'
      ) ?? []
    ).find(isFocusable);
    (titleInput && isFocusable(titleInput)
      ? titleInput
      : (preferred ?? getFocusable(dialog)[0] ?? dialog)
    )?.focus();
  });
}

function createState(container: HTMLElement): ModalState {
  const owner = topLevelOwner(container);
  const state: ModalState = {
    container,
    owner,
    opener: deepActiveElement(),
    overflow: document.body.style.getPropertyValue('overflow'),
    overflowPriority: document.body.style.getPropertyPriority('overflow'),
    // A registered flow already owns the page lock while its legacy screenshot
    // chooser is open. Restoring our snapshot after the flow closes would re-lock it.
    ownsScrollLock: !document.querySelector('[data-bugdrop-flow]'),
    inertBefore: new Map(),
    overlays: [],
    observer: new MutationObserver(() => {
      state.overlays = state.overlays.filter(overlay => overlay.isConnected);
      if (state.overlays.length === 0) scheduleFinish(state);
      else updateBackground(state);
    }),
    finishTimer: null,
    onKeydown: event => handleKeydown(state, event),
  };
  if (!state.ownsScrollLock) flowModalStates.add(state);
  if (state.ownsScrollLock) document.body.style.setProperty('overflow', 'hidden');
  container.addEventListener('keydown', state.onKeydown);
  state.observer.observe(container, { childList: true });
  if (container !== document.body) {
    state.observer.observe(document.body, { childList: true });
  }
  return state;
}

// Registered flows own their focus and scroll lifecycle. Release the legacy
// screenshot chooser's background isolation before the flow focuses its next
// screen or restores the page opener on close.
export function releaseLegacyModalIsolationForFlow(): void {
  for (const state of flowModalStates) {
    state.overlays = state.overlays.filter(overlay => overlay.isConnected);
    if (state.overlays.length === 0) finish(state, false);
  }
}

function updateBackground(state: ModalState): void {
  const owner = topLevelOwner(state.container);
  if (owner !== state.owner) {
    const wasInert = state.inertBefore.get(owner);
    if (wasInert !== undefined) owner.inert = wasInert;
    state.owner = owner;
  }
  const current = state.overlays.at(-1);
  for (const child of Array.from(document.body.children)) {
    if (child instanceof HTMLElement && child !== state.owner) makeInert(state, child);
  }
  for (const child of Array.from(state.container.children)) {
    if (child instanceof HTMLElement && child !== current) makeInert(state, child);
  }
  if (current) current.inert = false;
}

function makeInert(state: ModalState, element: HTMLElement): void {
  if (!state.inertBefore.has(element)) state.inertBefore.set(element, element.inert);
  element.inert = true;
}

function handleKeydown(state: ModalState, event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  const overlay = state.overlays.at(-1);
  if (!overlay || !(event.target instanceof Node) || !overlay.contains(event.target)) return;
  if (event.key === 'Escape') {
    const close = overlay.querySelector<HTMLButtonElement>('.bd-close');
    if (!close || close.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    close.click();
    return;
  }
  if (event.key !== 'Tab') return;
  const dialog = overlay.querySelector<HTMLElement>('.bd-modal');
  const focusable = getFocusable(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1)!;
  const active = deepActiveElement();
  if (event.shiftKey && (active === first || !dialog?.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog?.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function getFocusable(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(
    isFocusable
  );
}

function isFocusable(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (
      node.hidden ||
      node.inert ||
      node.getAttribute('aria-hidden') === 'true' ||
      getComputedStyle(node).display === 'none' ||
      getComputedStyle(node).visibility === 'hidden'
    ) {
      return false;
    }
  }
  return true;
}

function scheduleFinish(state: ModalState): void {
  if (state.finishTimer !== null) return;
  // The next screen is often created by a Promise continuation after the old one is removed.
  state.finishTimer = window.setTimeout(() => {
    state.finishTimer = null;
    if (state.overlays.length > 0) return;
    finish(state, true);
  }, 0);
}

function finish(state: ModalState, restoreFocus: boolean): void {
  if (state.finishTimer !== null) window.clearTimeout(state.finishTimer);
  state.finishTimer = null;
  state.observer.disconnect();
  state.container.removeEventListener('keydown', state.onKeydown);
  modalStates.delete(state.container);
  flowModalStates.delete(state);
  for (const [element, wasInert] of state.inertBefore) element.inert = wasInert;
  if (state.ownsScrollLock) {
    if (state.overflow) {
      document.body.style.setProperty('overflow', state.overflow, state.overflowPriority);
    } else {
      document.body.style.removeProperty('overflow');
    }
  }
  if (restoreFocus && state.opener?.isConnected && !state.opener.inert) state.opener.focus();
}

function deepActiveElement(): HTMLElement | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
}

function topLevelOwner(container: HTMLElement): HTMLElement {
  const root = container.getRootNode();
  let owner = root instanceof ShadowRoot ? root.host : container;
  while (owner.parentElement && owner.parentElement !== document.body) {
    owner = owner.parentElement;
  }
  return owner as HTMLElement;
}
