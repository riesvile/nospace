// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachNoSpace } from '../src/dom.js';
import type { NoSpaceSession } from '../src/engine.js';
import type { AnalysisResult, NoSpaceProvider } from '../src/types.js';

const sessions: NoSpaceSession[] = [];
const empty: AnalysisResult = { boundaries: [], typos: [], durationMs: 0 };
const provider: NoSpaceProvider = { analyze: async (input) => ({ ...empty,
  boundaries: input.boundaries.filter((b) => b.left.toLowerCase() === 'hello').map((b) => ({ id: b.id, probability: 0.99 })) }) };
afterEach(() => { sessions.splice(0).forEach((s) => s.destroy()); document.body.innerHTML = ''; });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function attach(element: HTMLTextAreaElement | HTMLInputElement, options = {}) {
  const session = attachNoSpace(element, { provider, capitalize: false, ...options });
  sessions.push(session); return session;
}
function type(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  element.value = value; element.setSelectionRange(value.length, value.length);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

describe('native controls', () => {
  it.each(['textarea', 'input'])('attaches to %s without changing its styles or taking focus', async (tag) => {
    const element = document.createElement(tag) as HTMLTextAreaElement | HTMLInputElement;
    element.style.color = 'red'; document.body.append(element);
    const onChange = vi.fn(); attach(element, { onChange });
    type(element, 'helloworld'); await tick();
    expect(element.value).toBe('hello world');
    expect(element.selectionStart).toBe(11);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello world' }), 'spacing');
    expect(element.style.color).toBe('red');
    expect(document.activeElement).not.toBe(element);
  });

  it('supports keyboard undo and redo, including automatic edits', async () => {
    const element = document.createElement('textarea'); attach(element);
    type(element, 'helloworld'); await tick();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }));
    expect(element.value).toBe('helloworld');
    element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyRedo', cancelable: true }));
    expect(element.value).toBe('hello world');
  });

  it('leaves composition events to the browser until committed', async () => {
    const element = document.createElement('textarea'); attach(element);
    element.dispatchEvent(new CompositionEvent('compositionstart'));
    type(element, 'helloworld'); await tick();
    expect(element.value).toBe('helloworld');
    element.dispatchEvent(new CompositionEvent('compositionend')); await tick();
    expect(element.value).toBe('hello world');
  });

  it('restores original attributes and removes handlers when detached', async () => {
    const element = document.createElement('textarea'); element.setAttribute('spellcheck', 'true');
    const session = attach(element); expect(element.getAttribute('spellcheck')).toBe('false');
    session.destroy(); session.destroy(); type(element, 'helloworld'); await tick();
    expect(element.value).toBe('helloworld');
    expect(element.getAttribute('spellcheck')).toBe('true');
    expect(element.hasAttribute('autocorrect')).toBe(false);
    expect(() => attach(element)).not.toThrow();
  });

  it('resets document history after a form reset', async () => {
    const form = document.createElement('form'); const element = document.createElement('textarea');
    element.defaultValue = 'original'; form.append(element); document.body.append(form);
    const session = attach(element); type(element, 'helloworld'); await tick();
    form.reset(); await tick();
    expect(session.text).toBe('original'); expect(session.undo()).toBe(false);
  });

  it('does not overwrite a readonly input when a pending result arrives', async () => {
    const element = document.createElement('textarea'); attach(element);
    type(element, 'helloworld'); element.readOnly = true; await tick();
    expect(element.value).toBe('helloworld');
  });

  it('rejects unsupported inputs and duplicate attachments', () => {
    const element = document.createElement('input'); element.type = 'password';
    expect(() => attach(element)).toThrow('supports');
    element.type = 'text'; attach(element);
    expect(() => attach(element)).toThrow('already attached');
  });
});
