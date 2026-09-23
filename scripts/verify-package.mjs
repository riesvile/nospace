import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'nospace-package-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary, '--cache', join(temporary, 'cache')], { cwd: root, encoding: 'utf8' }));
  for (const { path } of pack.files) {
    assert(/^(dist\/|package\.json$|README\.md$|LICENSE$|NOTICE$)/.test(path), `Unexpected packaged file: ${path}`);
    assert(!/(^|\/)(\.env[^/]*|deploy|routes|node_modules|test)(\/|$)/.test(path), `Excluded content leaked: ${path}`);
  }
  assert(pack.files.some((f) => f.path === 'dist/server/data/WORDNINJA-LICENSE'));

  // Traverse the whole static browser import graph, not just the barrel file.
  const visited = new Set();
  function inspect(file) {
    if (visited.has(file)) return;
    visited.add(file);
    assert(!file.includes('/server/'), `Server code in browser graph: ${file}`);
    const source = readFileSync(file, 'utf8');
    assert(!/api\.openai\.com|api\.typesafe\.ai|process\.env|node:/.test(source), `Server dependency in ${file}`);
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) inspect(resolve(dirname(file), match[1]));
  }
  inspect(join(root, 'dist/index.js')); inspect(join(root, 'dist/dom.js'));
  const portable = new Set();
  function inspectPortable(file) {
    if (portable.has(file)) return;
    portable.add(file);
    const source = readFileSync(file, 'utf8');
    assert(!/from ['"]node:/.test(source), `Node-only dependency in portable server: ${file}`);
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) inspectPortable(resolve(dirname(file), match[1]));
  }
  inspectPortable(join(root, 'dist/server/index.js'));
  execFileSync('tar', ['-xzf', join(temporary, pack.filename), '-C', temporary]);
  // Self-reference resolves the package export map from a clean extracted artifact.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const core = await import('@riesvile/nospace');
    const dom = await import('@riesvile/nospace/dom');
    const server = await import('@riesvile/nospace/server');
    assert.equal(typeof core.createNoSpace, 'function');
    assert.equal(typeof dom.attachNoSpace, 'function');
    assert.equal(typeof core.typographyEdits, 'function');
    const { UsageLimiter } = await import('@riesvile/nospace/server/node');
    const limiter = new UsageLimiter(':memory:');
    limiter.reserve('review', '192.0.2.1')();
    limiter.close();
    const provider = server.createJevLunaProvider({typesafeKey:'package-test-key', fetch:async (_url, init) => {
      const body = JSON.parse(init.body);
      assert(Object.values(body.questions).some(q => q.type === 'choice' && Object.values(q.criteria).includes('hello world')));
      return Response.json({answers:Object.fromEntries(Object.entries(body.questions).map(([key,q])=>[key,{probabilities:Object.fromEntries(Object.keys(q.criteria).map((option,i)=>[option,Number(i===0)]))}]))});
    }});
    await provider.analyze({raw:'helloworld', contextBefore:'', contextAfter:'', words:[], boundaries:[], paused:false}, new AbortController().signal);
  `], { cwd: join(temporary, 'package'), stdio: 'pipe' });
  console.log(`Verified ${pack.files.length} packaged files; ${visited.size} browser modules; clean package imports and vocabulary.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
