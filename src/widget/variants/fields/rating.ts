import type { RatingField } from '../public-types';
import { createFieldScaffold } from './shared';
import type { FieldController } from './types';

export function createRatingController(field: RatingField, instanceId: string): FieldController {
  const scaffold = createFieldScaffold(field, instanceId);
  const scale = field.scale ?? 5;
  const group = document.createElement('div');
  group.id = scaffold.controlId;
  group.className = 'bdv-rating';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', scaffold.labelId);
  group.setAttribute('aria-required', String(field.required ?? false));
  if (scaffold.describedBy) group.setAttribute('aria-describedby', scaffold.describedBy);

  const buttons: HTMLButtonElement[] = [];
  let selected: number | null = null;
  let previewed: number | null = null;

  const renderSelection = () => {
    for (const [index, button] of buttons.entries()) {
      const value = index + 1;
      const active = previewed === null && selected !== null && value <= selected;
      const preview = previewed !== null && value <= previewed;
      button.classList.toggle('bdv-rating-option--active', active);
      button.classList.toggle('bdv-rating-option--preview', preview);
      button.setAttribute('aria-checked', String(value === selected));
      button.tabIndex = value === (selected ?? 1) ? 0 : -1;
    }
  };
  const select = (value: number, focus = false) => {
    const changed = selected !== value;
    selected = value;
    previewed = null;
    renderSelection();
    if (focus) buttons[value - 1]?.focus();
    if (changed) group.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const listeners: Array<{
    button: HTMLButtonElement;
    click: () => void;
    keydown: (event: KeyboardEvent) => void;
    pointerenter: () => void;
  }> = [];
  const clearPreview = () => {
    if (previewed === null) return;
    previewed = null;
    renderSelection();
  };
  const handleGroupPointerMove = (event: PointerEvent) => {
    const target = event.target;
    if (target instanceof HTMLButtonElement && buttons.includes(target) && !target.disabled) return;
    clearPreview();
  };

  for (let value = 1; value <= scale; value += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bdv-rating-option';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-label', `${value} ${value === 1 ? 'star' : 'stars'}`);
    button.textContent = field.icon === 'number' ? String(value) : '★';
    const click = () => select(value);
    const pointerenter = () => {
      if (button.disabled) return;
      previewed = value;
      renderSelection();
    };
    const keydown = (event: KeyboardEvent) => {
      let next: number | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        next = value === scale ? 1 : value + 1;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        next = value === 1 ? scale : value - 1;
      } else if (event.key === 'Home') {
        next = 1;
      } else if (event.key === 'End') {
        next = scale;
      } else if (event.key === 'Enter' || event.key === ' ') {
        next = value;
      }
      if (next === null) return;
      event.preventDefault();
      select(next, true);
    };
    button.addEventListener('click', click);
    button.addEventListener('keydown', keydown);
    button.addEventListener('pointerenter', pointerenter);
    listeners.push({ button, click, keydown, pointerenter });
    buttons.push(button);
    group.appendChild(button);
  }
  group.addEventListener('pointermove', handleGroupPointerMove);
  group.addEventListener('pointerleave', clearPreview);
  scaffold.wrapper.insertBefore(group, scaffold.wrapper.querySelector('.bdv-error'));

  if (field.lowLabel || field.highLabel) {
    const labels = document.createElement('div');
    labels.className = 'bdv-rating-labels';
    const low = document.createElement('span');
    low.textContent = field.lowLabel ?? '';
    const high = document.createElement('span');
    high.textContent = field.highLabel ?? '';
    labels.append(low, high);
    scaffold.wrapper.insertBefore(labels, scaffold.wrapper.querySelector('.bdv-error'));
  }
  renderSelection();

  return {
    field,
    element: scaffold.wrapper,
    getValue: () => selected ?? '',
    setValue(value) {
      selected =
        Number.isInteger(value) && (value as number) >= 1 && (value as number) <= scale
          ? (value as number)
          : null;
      previewed = null;
      renderSelection();
    },
    setError: message => scaffold.setError(group, message),
    setDisabled(disabled) {
      for (const button of buttons) button.disabled = disabled;
      if (disabled) clearPreview();
    },
    focus() {
      buttons[(selected ?? 1) - 1]?.focus();
    },
    dispose() {
      clearPreview();
      group.removeEventListener('pointermove', handleGroupPointerMove);
      group.removeEventListener('pointerleave', clearPreview);
      for (const listener of listeners) {
        listener.button.removeEventListener('click', listener.click);
        listener.button.removeEventListener('keydown', listener.keydown);
        listener.button.removeEventListener('pointerenter', listener.pointerenter);
      }
    },
  };
}
