// Writing and verifying a generation (contract Layout and Validation). manifest.json is written last; run.json after
// it and outside the determinism contract.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { canonical, compareOrdinal } from '../util/canonical.ts';
import { schema, validate } from './schema.ts';
import { checkIntegrity, FILES, type RecordSet, type Rec } from './integrity.ts';

export const SCHEMA_VERSION = '1.1';
export const KNOWN_CAPABILITIES = new Set<string>();

export function writeNdjson(path: string, records: Rec[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, records.map((r) => canonical(r) + '\n').join(''));
}

export function readNdjson(path: string): Rec[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Rec);
}

export function writeRecords(outDir: string, set: RecordSet): void {
  for (const [key, file] of Object.entries(FILES) as [keyof RecordSet, string][]) writeNdjson(join(outDir, file), set[key]);
}

export function readRecords(dir: string): RecordSet {
  const set = {} as RecordSet;
  for (const [key, file] of Object.entries(FILES) as [keyof RecordSet, string][]) set[key] = readNdjson(join(dir, file));
  return set;
}

function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, root));
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

export function fileList(outDir: string): { path: string; sha256: string; size: number }[] {
  return walk(outDir)
    .filter((p) => p !== 'manifest.json' && p !== 'run.json')
    .sort(compareOrdinal)
    .map((p) => {
      const bytes = readFileSync(join(outDir, p));
      return { path: p, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    });
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  notes: string[];
}

/** verify <generation>: manifest schema, capabilities, checksums, unlisted files, then the record checks. */
export function verifyGeneration(dir: string): VerifyResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, errors: ['manifest.json is missing: this is not a complete generation'], notes };
  let manifest: Record<string, any>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`manifest.json is not JSON: ${(e as Error).message}`], notes };
  }
  errors.push(...validate(schema('manifest'), manifest).map((e) => `manifest.json ${e}`));
  const major = String(manifest.schemaVersion ?? '').split('.')[0];
  if (major !== '1') errors.push(`schemaVersion ${manifest.schemaVersion}: only major 1 is supported`);
  for (const cap of manifest.requiredCapabilities ?? []) if (!KNOWN_CAPABILITIES.has(cap)) errors.push(`unknown required capability '${cap}': refusing the generation`);
  const listed = new Map<string, { sha256: string; size: number }>();
  for (const f of manifest.files ?? []) listed.set(f.path, f);
  const present = new Set(walk(dir).filter((p) => p !== 'manifest.json' && p !== 'run.json'));
  for (const [path, f] of [...listed].sort(([a], [b]) => compareOrdinal(a, b))) {
    if (!present.has(path)) {
      errors.push(`${path}: listed in the manifest but missing`);
      continue;
    }
    const bytes = readFileSync(join(dir, path));
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== f.sha256) errors.push(`${path}: checksum mismatch (manifest ${f.sha256}, file ${sha})`);
    if (bytes.length !== f.size) errors.push(`${path}: size mismatch (manifest ${f.size}, file ${bytes.length})`);
  }
  for (const p of [...present].sort(compareOrdinal)) if (!listed.has(p)) errors.push(`${p}: present but not listed in the manifest`);
  let set: RecordSet;
  try {
    set = readRecords(dir);
  } catch (e) {
    errors.push(`records could not be read: ${(e as Error).message}`);
    return { ok: false, errors, notes };
  }
  const integrity = checkIntegrity(set);
  errors.push(...integrity.errors);
  notes.push(...integrity.notes);
  notes.push('repository blob ids are not checked without the repository');
  return { ok: errors.length === 0, errors, notes };
}
