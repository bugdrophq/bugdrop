// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createFlowFormScreen } from '../src/widget/flows/form-screen';
import type { FlowForm } from '../src/widget/flows/public-types';

const form: FlowForm = {
  id: 'details',
  title: 'Details',
  fields: [
    { id: 'first', type: 'shortText', label: 'First', layout: { span: 2 } },
    { id: 'agree', type: 'checkbox', label: 'Agree', helpText: 'Required consent', required: true },
    { id: 'last', type: 'longText', label: 'Last' },
    {
      id: 'files',
      type: 'attachments',
      label: 'Files',
      helpText: 'Attach evidence',
      required: true,
    },
  ],
};

describe('flow form screen', () => {
  it('caps mapped submitter fields to the Worker limits before a flow advances', async () => {
    const identityForm: FlowForm = {
      id: 'identity',
      title: 'Identity',
      fields: [
        { id: 'name', type: 'shortText', label: 'Name' },
        { id: 'email', type: 'longText', label: 'Email' },
        { id: 'notes', type: 'shortText', label: 'Notes' },
      ],
    };
    const controller = createFlowFormScreen(
      identityForm,
      'mapped',
      {},
      {
        name: 'identity.name',
        email: 'identity.email',
      }
    );
    document.body.appendChild(controller.element);
    const name = controller.element.querySelector<HTMLInputElement>('#mapped-name')!;
    const email = controller.element.querySelector<HTMLTextAreaElement>('#mapped-email')!;
    const notes = controller.element.querySelector<HTMLInputElement>('#mapped-notes')!;
    expect(name.maxLength).toBe(100);
    expect(email.maxLength).toBe(254);
    expect(notes.maxLength).toBe(500);

    name.value = 'n'.repeat(101);
    await expect(controller.collect()).resolves.toBeNull();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    name.value = 'n'.repeat(100);
    email.value = 'e'.repeat(255);
    await expect(controller.collect()).resolves.toBeNull();
    expect(email.getAttribute('aria-invalid')).toBe('true');
    controller.dispose();
    controller.element.remove();
  });

  it('applies every inherited field control through the thin FlowForm adapter', async () => {
    const inherited: FlowForm = {
      id: 'inherited',
      title: 'Inherited controls',
      fields: [
        {
          id: 'summary',
          type: 'shortText',
          label: 'Summary',
          helpText: 'Keep it concise',
          placeholder: 'A short summary',
          minLength: 3,
          maxLength: 40,
        },
        {
          id: 'detail',
          type: 'longText',
          label: 'Detail',
          placeholder: 'What happened?',
          rows: 7,
          minLength: 5,
          maxLength: 500,
        },
        {
          id: 'choice',
          type: 'singleChoice',
          label: 'Choice',
          options: [
            { value: 'first', label: 'First', description: 'The first described option' },
            { value: 'second', label: 'Second' },
          ],
        },
        {
          id: 'enabled',
          type: 'checkbox',
          label: 'Enabled by default',
          initialValue: true,
        },
      ],
    };
    const controller = createFlowFormScreen(inherited, 'adapter', {});
    const summary = controller.element.querySelector<HTMLInputElement>('#adapter-summary')!;
    const detail = controller.element.querySelector<HTMLTextAreaElement>('#adapter-detail')!;
    const choice = controller.element.querySelector<HTMLElement>('[data-bugdrop-field="choice"]')!;
    const enabled = controller.element.querySelector<HTMLInputElement>('#adapter-enabled')!;

    expect(summary.placeholder).toBe('A short summary');
    expect(summary.minLength).toBe(3);
    expect(summary.maxLength).toBe(40);
    expect(summary.getAttribute('aria-describedby')).toContain('adapter-summary-help');
    expect(controller.element.querySelector('#adapter-summary-help')?.textContent).toBe(
      'Keep it concise'
    );
    expect(detail.placeholder).toBe('What happened?');
    expect(detail.rows).toBe(7);
    expect(detail.minLength).toBe(5);
    expect(detail.maxLength).toBe(500);
    expect(choice.querySelector('.bdv-help')?.textContent).toBe('The first described option');
    expect(enabled.checked).toBe(true);
    await expect(controller.snapshot()).resolves.toMatchObject({ enabled: true });
  });

  it('focuses the first invalid shared or extra field', async () => {
    const requiredForm: FlowForm = {
      ...form,
      fields: form.fields.map(field =>
        field.id === 'first' ? { ...field, required: true } : field
      ),
    };
    const controller = createFlowFormScreen(requiredForm, 'required', {});
    document.body.appendChild(controller.element);

    await expect(controller.collect()).resolves.toBeNull();
    const first = controller.element.querySelector<HTMLInputElement>('#required-first')!;
    expect(first.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(first);
    const firstError = controller.element.querySelector<HTMLElement>('#required-first-error')!;
    expect(firstError.getAttribute('aria-live')).toBe('polite');
    expect(firstError.hidden).toBe(false);
    expect(firstError.textContent).toBe('is required');
    expect(first.getAttribute('aria-describedby')).toContain(firstError.id);

    first.value = 'Complete';
    await expect(controller.collect()).resolves.toBeNull();
    const agree = controller.element.querySelector<HTMLInputElement>('#required-agree')!;
    expect(agree.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(agree);
    const agreeError = controller.element.querySelector<HTMLElement>('#required-agree-error')!;
    expect(agreeError.getAttribute('aria-live')).toBe('polite');
    expect(agreeError.hidden).toBe(false);
    expect(agreeError.textContent).toBe('This checkbox is required.');
    expect(agree.getAttribute('aria-describedby')).toContain(agreeError.id);
  });

  it('reads an accepted attachment and exposes its stable evidence envelope', async () => {
    const controller = createFlowFormScreen(form, 'accepted', { 'details.agree': true });
    const input = controller.element.querySelector<HTMLInputElement>('#accepted-files')!;
    Object.defineProperty(input, 'files', {
      value: [new File(['trace'], 'trace.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change'));

    await expect(controller.collect()).resolves.toMatchObject({
      agree: true,
      files: [
        {
          name: 'trace.png',
          type: 'image/png',
          size: 5,
          dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        },
      ],
    });
    expect(controller.element.querySelector('.bdf-file-list')?.textContent).toBe('trace.png');
  });

  it('preserves declared order, layout, help relationships, and snapshots without required validation', async () => {
    const controller = createFlowFormScreen(form, 'instance', {
      'details.first': 'One',
      'details.last': 'Three',
    });
    const fields = [...controller.element.querySelectorAll<HTMLElement>('[data-bugdrop-field]')];
    expect(fields.map(field => field.dataset.bugdropField)).toEqual([
      'first',
      'agree',
      'last',
      'files',
    ]);
    expect(fields[0]?.dataset.span).toBe('2');
    const checkbox = controller.element.querySelector<HTMLInputElement>('#instance-agree')!;
    expect(checkbox.getAttribute('aria-describedby')).toContain('instance-agree-help');
    await expect(controller.snapshot()).resolves.toMatchObject({
      first: 'One',
      agree: false,
      last: 'Three',
      files: [],
    });
    expect(checkbox.getAttribute('aria-invalid')).toBeNull();
  });

  it('enforces selected attachment count, type, size, and latest-read race behavior', async () => {
    const fileForm: FlowForm = {
      ...form,
      fields: form.fields.map(field =>
        field.id === 'files'
          ? { ...field, maxFiles: 1, maxFileSize: 1, accept: ['image/png'] }
          : field
      ),
    };
    const constrained = createFlowFormScreen(fileForm, 'constrained', { 'details.agree': true });
    const input = constrained.element.querySelector<HTMLInputElement>('#constrained-files')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [
        new File(['a'], 'a.png', { type: 'image/png' }),
        new File(['b'], 'b.png', { type: 'image/png' }),
      ],
    });
    input.dispatchEvent(new Event('change'));
    await expect(constrained.collect()).resolves.toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(constrained.element.textContent).toContain('Select at most 1 attachment');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['archive'], 'archive.zip', { type: 'application/zip' })],
    });
    input.dispatchEvent(new Event('change'));
    await expect(constrained.collect()).resolves.toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(constrained.element.textContent).toContain('unsupported file type');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['ab'], 'large.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change'));
    await expect(constrained.collect()).resolves.toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(constrained.element.textContent).toContain('large.png is too large');

    const readers: Array<{ file?: File; resolve(): void }> = [];
    class ControlledReader {
      result: string | ArrayBuffer | null = null;
      private load: (() => void) | null = null;
      addEventListener(type: string, listener: () => void) {
        if (type === 'load') this.load = listener;
      }
      readAsDataURL(file: File) {
        const entry = {
          file,
          resolve: () => {
            this.result = `data:${file.type};base64,QQ==`;
            this.load?.();
          },
        };
        readers.push(entry);
      }
    }
    vi.stubGlobal('FileReader', ControlledReader);
    const raced = createFlowFormScreen(form, 'raced', { 'details.agree': true });
    const racedInput = raced.element.querySelector<HTMLInputElement>('#raced-files')!;
    Object.defineProperty(racedInput, 'files', {
      configurable: true,
      value: [new File(['a'], 'old.png', { type: 'image/png' })],
    });
    racedInput.dispatchEvent(new Event('change'));
    Object.defineProperty(racedInput, 'files', {
      configurable: true,
      value: [new File(['b'], 'new.png', { type: 'image/png' })],
    });
    racedInput.dispatchEvent(new Event('change'));
    readers[1]!.resolve();
    await Promise.resolve();
    readers[0]!.resolve();
    await Promise.resolve();
    await expect(raced.collect()).resolves.toMatchObject({ files: [{ name: 'new.png' }] });
    vi.unstubAllGlobals();
  });

  it('waits for a replacement selection made while collection is pending', async () => {
    const readers: Array<{ file?: File; resolve(): void }> = [];
    class ControlledReader {
      result: string | ArrayBuffer | null = null;
      private load: (() => void) | null = null;
      addEventListener(type: string, listener: () => void) {
        if (type === 'load') this.load = listener;
      }
      readAsDataURL(file: File) {
        readers.push({
          file,
          resolve: () => {
            this.result = `data:${file.type};base64,QQ==`;
            this.load?.();
          },
        });
      }
    }
    vi.stubGlobal('FileReader', ControlledReader);
    const previous = {
      name: 'previous.png',
      type: 'image/png',
      size: 1,
      dataUrl: 'data:image/png;base64,QQ==',
    };
    const controller = createFlowFormScreen(form, 'instance', {
      'details.agree': true,
      'details.files': [previous],
    });
    const input = controller.element.querySelector<HTMLInputElement>('#instance-files')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['a'], 'a.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change'));
    let settled = false;
    const collected = controller.collect().then(value => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['b'], 'b.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change'));
    readers[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    readers[1]!.resolve();
    await expect(collected).resolves.toMatchObject({ files: [{ name: 'b.png' }] });
    vi.unstubAllGlobals();
  });

  it('snapshots the last valid attachment after a read failure without accepting it forward', async () => {
    const previous = {
      name: 'previous.txt',
      type: 'text/plain',
      size: 1,
      dataUrl: 'data:text/plain;base64,eA==',
    };
    const fileForm: FlowForm = {
      ...form,
      fields: form.fields.map(field =>
        field.id === 'files' ? { ...field, maxFileSize: 1 } : field
      ),
    };
    const controller = createFlowFormScreen(fileForm, 'instance', {
      'details.agree': true,
      'details.files': [previous],
    });
    const input = controller.element.querySelector<HTMLInputElement>('#instance-files')!;
    Object.defineProperty(input, 'files', {
      value: [new File(['too large'], 'large.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change'));

    await expect(controller.collect()).resolves.toBeNull();
    await expect(controller.snapshot()).resolves.toMatchObject({ files: [previous] });
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});
