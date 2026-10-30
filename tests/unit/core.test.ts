import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, recordId, gitBlobId } from '../../src/util/canonical.ts';
import { redactLine, isSecret } from '../../src/secrets.ts';
import { canonicalRoute, splitUrl } from '../../src/angular/fold.ts';
import { readJsonc, norm, joinRepo, discover } from '../../src/discovery.ts';
import { stripCredentials } from '../../src/workingcopy.ts';
import { validate, schema } from '../../src/artifacts/schema.ts';
import { tail } from '../../src/install.ts';
import { writeIndex } from '../../src/artifacts/sqlite.ts';
import { DatabaseSync } from 'node:sqlite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('canonical JSON sorts keys ordinally and drops undefined', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x'], B: undefined, c: { z: 1, y: 2 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  assert.equal(canonical({ Z: 1, a: 2 }), '{"Z":1,"a":2}');
});

test('record ids are prefix plus 32 hex of SHA-256 of canonical fields', () => {
  const id = recordId('ev', { b: 2, a: 1 });
  assert.match(id, /^ev:[0-9a-f]{32}$/);
  assert.equal(id, `ev:${createHash('sha256').update('{"a":1,"b":2}').digest('hex').slice(0, 32)}`);
});

test('git blob ids match git hash-object', () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(gitBlobId(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('secret values and keys are redacted from snippet lines', () => {
  assert.equal(redactLine("  apiKey: 'abc123',"), "  apiKey: '[redacted]',");
  assert.equal(redactLine('  "clientSecret": "s3cr3t-value",'), '  "clientSecret": "[redacted]",');
  assert.equal(redactLine("  apiUrl: 'https://api.example.test',"), "  apiUrl: 'https://api.example.test',");
  assert.equal(redactLine("  token: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh`"), '  token: `[redacted]`');
  assert.equal(redactLine("const x = 'AKIAABCDEFGHIJKLMNOP';"), "const x = '[redacted]';");
  assert.equal(redactLine('DB_PASSWORD=hunter2'), 'DB_PASSWORD=[redacted]');
  assert.equal(redactLine("  private readonly fallbackKey = 'inline-value-0042';"), "  private readonly fallbackKey = '[redacted]';");
  assert.ok(isSecret('url', 'https://user:pw@host.test/x'));
  assert.ok(!isSecret('clientId', 'Web'));
});

test('canonical routes: one leading slash, lower-case literals, {} parameters, no query', () => {
  assert.equal(canonicalRoute('api/Orders/{}?expand=1'), '/api/orders/{}');
  assert.equal(canonicalRoute('/api//items/'), '/api/items');
  assert.equal(canonicalRoute('https://host.test:5000/API/x'), '/api/x');
  assert.equal(canonicalRoute(''), '/');
  assert.deepEqual(splitUrl('https://h.test/a/b'), { origin: 'https://h.test', path: '/a/b' });
  assert.equal(splitUrl('/a'), null);
});

test('JSON with comments and trailing commas (tsconfig, angular.json)', () => {
  assert.deepEqual(readJsonc('{ // c\n "a": "x//y", /* b */ "b": [1,2,], }'), { a: 'x//y', b: [1, 2] });
  assert.equal(norm('./a/b/'), 'a/b');
  assert.equal(norm(''), '.');
  assert.equal(joinRepo('.', 'src/app'), 'src/app');
  assert.equal(joinRepo('apps/web', '../lib'), 'apps/lib');
});

test('remote URLs and install logs lose credentials', () => {
  assert.equal(stripCredentials('https://user:token@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(stripCredentials('git@github.com:o/r.git'), 'git@github.com:o/r.git');
  assert.ok(!tail('npm error 401 //registry.test/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123\n').includes('npm_abcdefghij'));
});

test('schema validator: required, enum, pattern, const', () => {
  const s = schema('relation');
  assert.deepEqual(validate(s, { id: 'rel:' + '0'.repeat(32), kind: 'x', from: 'a', to: 'b', context: 'ctx:' + '0'.repeat(32), resolution: 'exact', evidence: ['ev:' + '1'.repeat(32)] }), []);
  const errors = validate(s, { id: 'rel:1', kind: 'x', from: 'a', context: 'c', resolution: 'maybe', evidence: [] });
  assert.ok(errors.some((e) => e.includes("missing required 'to'")));
  assert.ok(errors.some((e) => e.includes('maybe')));
  assert.ok(errors.some((e) => e.includes('fewer than 1')));
  assert.ok(validate(schema('entity'), { id: 'ts:.:src/a#A', kind: 'class', name: 'A', container: null, signature: 'class A', accessibility: 'export', modifiers: [], origin: 'source' }).length === 0);
});

test('vendored contract schema has not drifted from schema/VENDOR.json', () => {
  const vendor = JSON.parse(readFileSync(join(root, 'schema', 'VENDOR.json'), 'utf8'));
  const files = (readdirSync(join(root, 'schema'), { recursive: true }) as string[])
    .map((f) => f.split('\\').join('/'))
    .filter((f) => f !== 'VENDOR.json' && /\.(json|sql)$/.test(f))
    .sort();
  assert.deepEqual(files, Object.keys(vendor.files).sort());
  for (const f of files) {
    const sha = createHash('sha256').update(readFileSync(join(root, 'schema', f))).digest('hex');
    assert.equal(sha, vendor.files[f], `${f} differs from the contract at ${vendor.tag} (${vendor.commit})`);
  }
});

test('install root: an unrelated ancestor lockfile does not apply; a workspace root does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-discovery-'));
  const files: Record<string, string> = {
    // Root package with its own lockfile, not a workspace (eShopOnAbp has this shape).
    'package.json': '{"dependencies":{"left-pad":"1.3.0"}}',
    'yarn.lock': '',
    'apps/web/package.json': '{"name":"web"}',
    'apps/web/angular.json': '{"version":1,"projects":{"web":{"projectType":"application","root":"","sourceRoot":"src","architect":{"build":{"options":{"tsConfig":"tsconfig.app.json"}}}}}}',
    'apps/web/tsconfig.app.json': '{}',
    // A real workspace: its member installs at the workspace root.
    'tools/package.json': '{"private":true,"workspaces":["packages/*"]}',
    'tools/package-lock.json': '{}',
    'tools/packages/lib/package.json': '{"name":"lib"}',
    'tools/packages/lib/tsconfig.json': '{}',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const found = discover(dir, Object.keys(files).sort());
  const byPath = new Map(found.projects.map((p) => [p.path, p.installRoot]));
  assert.equal(byPath.get('apps/web'), 'apps/web');
  assert.equal(byPath.get('tools/packages/lib'), 'tools');
});

test('index.sqlite has exactly the base statements of the vendored index.sql (index schema 1) and the v1.2 meta keys', () => {
  const sql = readFileSync(join(root, 'schema', 'index', 'v1', 'index.sql'), 'utf8');
  const base = sql.slice(sql.indexOf('-- base'), sql.indexOf('-- evidence')).split('\n').filter((l) => l.startsWith('create ')).map((l) => l.replace(/\s+/g, ' ').replace(/;$/, ''));
  const path = join(mkdtempSync(join(tmpdir(), 'ai-index-')), 'index.sqlite');
  const empty = { projects: [], entities: [], declarations: [], relations: [], evidence: [], observations: [], links: [], diagnostics: [], snippets: [] };
  writeIndex(path, empty, { schemaVersion: '1.2', commit: 'c', engine: 'e@1', indexSchema: '1', status: 'complete', coverage: '{}' });
  const db = new DatabaseSync(path, { readOnly: true });
  const made = (db.prepare("select sql from sqlite_master where sql is not null and name not like 'search_%'").all() as { sql: string }[]).map((r) => r.sql.replace(/\s+/g, ' ').replace(/^CREATE TABLE/, 'create table'));
  const meta = (db.prepare('select key from meta order by key').all() as { key: string }[]).map((r) => r.key);
  db.close();
  assert.deepEqual(made.map((s) => s.toLowerCase()).sort(), base.map((s) => s.toLowerCase()).sort());
  assert.deepEqual(meta, ['commit', 'coverage', 'engine', 'indexSchema', 'schemaVersion', 'status']);
});
