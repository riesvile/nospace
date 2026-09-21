import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/server/data/WORDNINJA-LICENSE', import.meta.url),
  new URL('../dist/server/data/WORDNINJA-LICENSE', import.meta.url));
