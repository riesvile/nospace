import type { AnalysisInput, AnalysisResult, WordCandidate } from './types.js';
import { startsSentence } from './sentences.js';

interface Atom {
  id: number;
  char: string;
  space: boolean;
  blocked: boolean;
  sequence: number;
}

interface Unit { char: string; id: number; automatic: boolean }
export interface Bookmark extends WordCandidate { ids: number[]; epoch: number }
export interface Snapshot {
  epoch: number;
  sequence: number;
  ids: number[];
  input: AnalysisInput;
  words: Bookmark[];
}

const wordPattern = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const letter = (char: string) => /[\p{L}\p{N}]/u.test(char);

/** Character identities survive appends; model-owned spaces are a separate layer. */
export class WritingDocument {
  private atoms: Atom[] = [];
  private nextId = 1;
  private nextSequence = 1;
  private undoStack: Atom[][] = [];
  private redoStack: Atom[][] = [];
  epoch = 0;

  constructor(text = '') { this.atoms = this.create(text); }

  private create(text: string): Atom[] {
    // UTF-16 units match textarea selection offsets, including emoji/surrogate pairs.
    return text.split('').map((char) => ({
      id: this.nextId++, char, space: false, blocked: false, sequence: 0
    }));
  }

  private units(): Unit[] {
    return this.atoms.flatMap((atom, index) => [
      ...(atom.space && index > 0 ? [{ char: ' ', id: atom.id, automatic: true }] : []),
      { char: atom.char, id: atom.id, automatic: false }
    ]);
  }

  get text(): string { return this.units().map((unit) => unit.char).join(''); }

  capitalizeSentences(): boolean {
    const text = this.text;
    const units = this.units();
    const capitalized = new Map<number, string>();
    for (const match of text.matchAll(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu)) {
      const first = match[0][0];
      const upper = first.toUpperCase();
      if (first !== upper && upper.length === 1 && startsSentence(text.slice(0, match.index))) {
        capitalized.set(units[match.index].id, upper);
      }
    }
    if (!capitalized.size) return false;
    this.checkpoint();
    for (const atom of this.atoms) atom.char = capitalized.get(atom.id) ?? atom.char;
    return true;
  }

  private checkpoint() {
    this.undoStack.push(this.atoms.map((atom) => ({ ...atom })));
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
  }

  edit(next: string): { appended: boolean } {
    const previous = this.text;
    if (previous === next) return { appended: true };
    this.checkpoint();
    let start = 0;
    while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
    let end = previous.length;
    let nextEnd = next.length;
    while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
    const appended = start === previous.length;
    if (!appended) this.epoch++;

    const units = this.units();
    const removed = units.slice(start, end);
    const blocked = new Set(removed.filter((unit) => unit.automatic).map((unit) => unit.id));
    const inserted = this.create(next.slice(start, nextEnd));
    const byId = new Map([...this.atoms, ...inserted].map((atom) => [atom.id, atom]));
    const nextUnits = [
      ...units.slice(0, start),
      ...inserted.map((atom) => ({ char: atom.char, id: atom.id, automatic: false })),
      ...units.slice(end)
    ];
    this.atoms = [];
    let pendingSpace = false;
    for (const unit of nextUnits) {
      if (unit.automatic) {
        if (!this.atoms.length || pendingSpace) this.atoms.push(...this.create(' '));
        else pendingSpace = true;
      } else {
        const atom = byId.get(unit.id)!;
        this.atoms.push({ ...atom, space: pendingSpace, blocked: atom.blocked || blocked.has(atom.id) });
        pendingSpace = false;
      }
    }
    if (pendingSpace) this.atoms.push(...this.create(' '));
    return { appended };
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this.atoms.map((atom) => ({ ...atom })));
    this.atoms = previous;
    this.epoch++;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.atoms.map((atom) => ({ ...atom })));
    this.atoms = next;
    this.epoch++;
    return true;
  }

  /** Remap selection by character identity when spaces or earlier words change. */
  anchor(offset: number) {
    const units = this.units();
    const left = units.slice(0, offset).reverse().find((unit) => !unit.automatic);
    const right = units.slice(offset).find((unit) => !unit.automatic);
    return { left: left?.id, right: right?.id, fallback: offset, atEnd: offset === units.length };
  }

  resolve(anchor: ReturnType<WritingDocument['anchor']>): number {
    const units = this.units();
    if (anchor.atEnd) return units.length;
    const right = units.findIndex((unit) => unit.id === anchor.right && !unit.automatic);
    if (right >= 0) return right;
    const left = units.findIndex((unit) => unit.id === anchor.left && !unit.automatic);
    return left >= 0 ? left + 1 : Math.min(anchor.fallback, units.length);
  }

  snapshot(caret: number, paused = false): Snapshot {
    const units = this.units();
    const rawCaret = units.slice(0, caret).filter((unit) => !unit.automatic).length;
    let from = Math.max(0, rawCaret - 48);
    // Start at a known word boundary when the rolling window cuts an old word.
    if (from > 0) {
      const boundary = this.atoms.slice(from, from + 12).findIndex((atom, index) =>
        atom.space || /\s/.test(this.atoms[from + index - 1]?.char ?? ''));
      if (boundary >= 0) from += boundary;
    }
    const to = Math.min(this.atoms.length, rawCaret + 16);
    const window = this.atoms.slice(from, to);
    const raw = window.map((atom) => atom.char).join('');
    const boundaries = window.flatMap((atom, index) => {
      if (index === 0 || atom.blocked || !letter(atom.char) ||
          !(letter(window[index - 1].char) || /[,;:!?.]/.test(window[index - 1].char))) return [];
      return [{ id: atom.id, left: raw.slice(0, index), right: raw.slice(index) }];
    });
    const text = this.text;
    const words: Bookmark[] = [];
    for (const match of text.matchAll(wordPattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const terminal = end === text.length;
      if (end < caret - 100 || start > caret + 24 || (terminal && !paused) || match[0].length < 2 || match[0].length > 48) continue;
      // Only complete words. A pause allows a conservative check of the last word.
      const ids = units.slice(start, end).filter((unit) => !unit.automatic).map((unit) => unit.id);
      words.push({
        key: ids.join('-'), ids, epoch: this.epoch, word: match[0], terminal,
        before: text.slice(Math.max(0, start - 160), start), after: text.slice(end, end + 100)
      });
    }
    const selected = words.slice(-6);
    const render = (atoms: Atom[]) => atoms.map((atom) => `${atom.space ? ' ' : ''}${atom.char}`).join('');
    return {
      epoch: this.epoch, sequence: this.nextSequence++, ids: window.map((atom) => atom.id), words: selected,
      input: {
        contextBefore: render(this.atoms.slice(Math.max(0, from - 200), from)), raw,
        contextAfter: render(this.atoms.slice(to, to + 100)), boundaries,
        words: selected.map(({ ids: _ids, epoch: _epoch, ...word }) => word), paused
      }
    };
  }

  applySpacing(snapshot: Snapshot, results: AnalysisResult['boundaries']): boolean {
    if (snapshot.epoch !== this.epoch || !snapshot.ids.length) return false;
    const start = this.atoms.findIndex((atom) => atom.id === snapshot.ids[0]);
    if (start < 0 || snapshot.ids.some((id, i) => this.atoms[start + i]?.id !== id)) return false;
    const allowed = new Set(snapshot.input.boundaries.map((boundary) => boundary.id));
    const decisions = new Map(results.filter((r) => allowed.has(r.id)).map((r) => [r.id, r.probability]));
    let changed = false;
    for (const atom of this.atoms) {
      const probability = decisions.get(atom.id);
      if (probability === undefined || !Number.isFinite(probability) || atom.blocked || atom.sequence > snapshot.sequence) continue;
      atom.sequence = snapshot.sequence;
      // Hysteresis prevents flicker while evidence for a boundary is ambiguous.
      const space = probability >= 0.65 ? true : probability <= 0.25 ? false : atom.space;
      if (space !== atom.space) {
        if (!changed) this.checkpoint();
        atom.space = space;
        changed = true;
      }
    }
    return changed;
  }

  isCurrent(bookmark: Bookmark): boolean {
    if (bookmark.epoch !== this.epoch) return false;
    const start = this.atoms.findIndex((atom) => atom.id === bookmark.ids[0]);
    if (start < 0 || bookmark.ids.some((id, i) => this.atoms[start + i]?.id !== id)) return false;
    const atoms = this.atoms.slice(start, start + bookmark.ids.length);
    if (atoms.map((atom) => atom.char).join('') !== bookmark.word || atoms.slice(1).some((atom) => atom.space)) return false;
    const previous = this.atoms[start - 1];
    const next = this.atoms[start + atoms.length];
    const partOfWord = (char: string) => /[\p{L}\p{M}'’]/u.test(char);
    return !(previous && !atoms[0].space && partOfWord(previous.char)) &&
      !(next && !next.space && partOfWord(next.char));
  }

  correct(bookmark: Bookmark, replacement: string): boolean {
    if (!this.isCurrent(bookmark) || replacement === bookmark.word || !/^[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*$/u.test(replacement)) return false;
    const index = this.atoms.findIndex((atom) => atom.id === bookmark.ids[0]);
    this.checkpoint();
    const inserted = this.create(replacement);
    inserted[0].space = this.atoms[index].space;
    inserted[0].blocked = this.atoms[index].blocked;
    this.atoms.splice(index, bookmark.ids.length, ...inserted);
    return true;
  }
}
