import type { ManagedWidgetAPI } from './ui';
function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error('Managed widget failed to initialize');
  return element;
}
function trapTab(event: KeyboardEvent, dialog: HTMLElement, shadow: ShadowRoot): void {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>('button, input, textarea, select')
  ).filter(element => !element.hasAttribute('disabled') && !element.closest('[hidden]'));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = shadow.activeElement;
  if (!focusable.includes(active as HTMLElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && shadow.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

export function createManagedController(
  shadow: ShadowRoot,
  isDraft: () => boolean
): ManagedWidgetAPI {
  const root = required<HTMLElement>(shadow, '.root');
  const launcher = required<HTMLButtonElement>(shadow, '[data-action="open"]');
  const backdrop = required<HTMLElement>(shadow, '.backdrop');
  const dialog = required<HTMLElement>(shadow, '[data-role="dialog"]');
  const closeButton = required<HTMLButtonElement>(shadow, '[data-action="close"]');
  const titleInput = required<HTMLInputElement>(shadow, 'input[name="title"]');
  let focusReturn: HTMLElement | null = null;
  const api: ManagedWidgetAPI = {
    open() {
      if (!backdrop.hidden) return;
      focusReturn = (shadow.activeElement ?? document.activeElement) as HTMLElement | null;
      backdrop.hidden = false;
      (isDraft() ? titleInput : closeButton).focus();
    },
    close() {
      if (backdrop.hidden) return;
      backdrop.hidden = true;
      if (focusReturn?.isConnected) focusReturn.focus();
      else if (!launcher.hidden) launcher.focus();
    },
    hide() {
      launcher.hidden = true;
    },
    show() {
      launcher.hidden = false;
    },
    isOpen() {
      return !backdrop.hidden;
    },
    isButtonVisible() {
      return !launcher.hidden;
    },
    setTheme(theme) {
      if (theme === 'light' || theme === 'dark' || theme === 'auto') root.dataset.theme = theme;
    },
  };

  launcher.addEventListener('click', () => api.open());
  closeButton.addEventListener('click', () => api.close());
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      api.close();
    } else trapTab(event, dialog, shadow);
  });
  return api;
}
