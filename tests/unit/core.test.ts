import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, recordId, gitBlobId } from '../../src/util/canonical.ts';
import { redactLine, isSecret } from '../../src/secrets.ts';
import { canonicalRoute, splitUrl } from '../../src/angular/fold.ts';
import { readJsonc, norm, joinRepo } from '../../src/discovery.ts';
import { stripCredentials } from '../../src/workingcopy.ts';
import { validate, schema } from '../../src/artifacts/schema.ts';
import { tail } from '../../src/install.ts';

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
  const files = readdirSync(join(root, 'schema', 'v1')).sort();
  assert.deepEqual(files, Object.keys(vendor.files).sort());
  for (const f of files) {
    const sha = createHash('sha256').update(readFileSync(join(root, 'schema', 'v1', f))).digest('hex');
    assert.equal(sha, vendor.files[f], `${f} differs from intelligence-contract ${vendor.commit}`);
  }
});
