import wordsText from './data/words.js';
import { contractions } from './contractions.js';

// A small k-best word-break search only proposes options. Jev chooses the
// interpretation; the dictionary never inserts a space on its own.
const words = wordsText.split('\n');
const cost = new Map(words.map((word, rank) => [word, Math.log((rank + 1) * Math.log(words.length))]));
cost.set('spacebar', 11);
for (const [plain, contraction] of Object.entries(contractions)) {
  // Keep the apostrophe and following letter attached when the next word grows.
  cost.set(contraction.toLowerCase(), Math.min(cost.get(plain) ?? 10, 10));
}
const prefixes = new Map<string, number>();
for (const [word, value] of cost) {
  for (let i = 1; i < word.length; i++) {
    const prefix = word.slice(0, i);
    if (!prefixes.has(prefix)) prefixes.set(prefix, value + 2);
  }
}
// Keep common typo tokens intact so they can reach Jev's typo gate and Luna.
for (const [typo, intended] of Object.entries({ teh: 'the', adn: 'and', recieve: 'receive', definately: 'definitely', seperate: 'separate', wierd: 'weird', becuase: 'because', thier: 'their' })) {
  cost.set(typo, (cost.get(intended) ?? 10) + 3);
}

interface Path { parts: string[]; cost: number }

export function spacingCandidates(raw: string, allowPartial = true): string[] {
  if (!/^[a-z]+(?:['’][a-z]+)*$/i.test(raw) || raw.length > 64) return [raw];
  const paths: Path[][] = Array.from({ length: raw.length + 1 }, () => []);
  paths[0] = [{ parts: [], cost: 0 }];
  for (let end = 1; end <= raw.length; end++) {
    const choices: Path[] = [];
    for (let start = Math.max(0, end - 24); start < end; start++) {
      const part = raw.slice(start, end);
      if (!/^[a-z]+(?:['’][a-z]+)*$/i.test(part)) continue;
      const lower = part.toLowerCase().replaceAll('’', "'");
      let value = cost.get(lower);
      if (value === undefined && lower.endsWith("'s") && cost.has(lower.slice(0, -2))) {
        value = cost.get(lower.slice(0, -2))! + 1;
      }
      if (end === raw.length && allowPartial && prefixes.has(lower)) value = Math.min(value ?? Infinity, prefixes.get(lower)!);
      if (value === undefined) {
        if (part.length < 3) continue;
        value = 18 + part.length * 1.6;
      }
      for (const path of paths[start]) choices.push({ parts: [...path.parts, part], cost: path.cost + value });
    }
    paths[end] = choices.sort((a, b) => a.cost - b.cost).slice(0, 8);
  }
  return [...new Set([raw, ...paths[raw.length].map((path) => path.parts.join(' '))])];
}

export function boundaryOffsets(spaced: string): Set<number> {
  const offsets = new Set<number>();
  let index = 0;
  for (const char of spaced) {
    if (char === ' ') offsets.add(index);
    else index += char.length;
  }
  return offsets;
}
