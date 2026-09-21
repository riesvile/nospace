import { createNoSpace, type NoSpaceOptions, type NoSpaceSession } from './engine.js';
import type { ChangeReason, EditorState } from './types.js';

export interface AttachOptions extends Omit<NoSpaceOptions, 'editor'> {
  /** Called after each library edit. Update controlled framework state here. */
  onChange?(state: EditorState, reason: ChangeReason): void;
}

const attached = new WeakSet<HTMLElement>();

/** Attach to a textarea or an input of type text/search/tel/url. No styling. */
export function attachNoSpace(element: HTMLTextAreaElement | HTMLInputElement, options: AttachOptions): NoSpaceSession {
  const tag = element.tagName.toLowerCase();
  if (tag !== 'textarea' && !(tag === 'input' && ['text', 'search', 'tel', 'url'].includes((element as HTMLInputElement).type))) {
    throw new TypeError('nospace supports textarea and text/search/tel/url inputs. Use a custom adapter for other editors.');
  }
  if (attached.has(element)) throw new Error('nospace is already attached to this element.');
  attached.add(element);
  const attributes = ['autocorrect', 'autocapitalize', 'spellcheck'] as const;
  const previousAttributes = new Map(attributes.map((name) => [name, element.getAttribute(name)]));
  let session: NoSpaceSession;
  try {
    session = createNoSpace({ ...options, editor: {
      isEditable: () => !element.disabled && !element.readOnly,
      getState: () => ({ text: element.value, selectionStart: element.selectionStart ?? 0,
        selectionEnd: element.selectionEnd ?? 0, selectionDirection: element.selectionDirection ?? 'none' }),
      setState(state, reason) {
        const top = element.scrollTop;
        const left = element.scrollLeft;
        element.value = state.text;
        element.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection);
        element.scrollTop = top;
        element.scrollLeft = left;
        options.onChange?.(state, reason);
      }
    } });
  } catch (error) { attached.delete(element); throw error; }
  element.setAttribute('autocorrect', 'off');
  element.setAttribute('autocapitalize', 'off');
  element.setAttribute('spellcheck', 'false');
  let composing = false;
  let destroyed = false;
  const input = () => session.input();
  const compositionStart = () => { composing = true; session.compositionStart(); };
  const compositionEnd = () => { composing = false; session.compositionEnd(); };
  const keydown = (rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (event.defaultPrevented || event.isComposing || composing || element.disabled || element.readOnly) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? session.redo() : session.undo();
    } else if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      session.redo();
    }
  };
  const beforeinput = (rawEvent: Event) => {
    const event = rawEvent as InputEvent;
    if (event.defaultPrevented || composing || element.disabled || element.readOnly) return;
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault();
      event.inputType === 'historyRedo' ? session.redo() : session.undo();
    }
  };
  const form = element.form;
  const reset = (event: Event) => queueMicrotask(() => {
    if (!destroyed && !event.defaultPrevented) { composing = false; session.reset(); }
  });
  element.addEventListener('input', input);
  element.addEventListener('compositionstart', compositionStart);
  element.addEventListener('compositionend', compositionEnd);
  element.addEventListener('keydown', keydown);
  element.addEventListener('beforeinput', beforeinput);
  form?.addEventListener('reset', reset);
  return {
    ...session,
    get text() { return session.text; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      session.destroy();
      element.removeEventListener('input', input);
      element.removeEventListener('compositionstart', compositionStart);
      element.removeEventListener('compositionend', compositionEnd);
      element.removeEventListener('keydown', keydown);
      element.removeEventListener('beforeinput', beforeinput);
      form?.removeEventListener('reset', reset);
      for (const name of attributes) {
        const previous = previousAttributes.get(name);
        if (previous == null) element.removeAttribute(name); else element.setAttribute(name, previous);
      }
      attached.delete(element);
    }
  };
}
