// Validator for the JSON Schema subset the contract uses (type, required, properties, enum, const, pattern, items,
// minItems, minimum). The vendored schemas (schema/v1, intelligence-contract) are embedded in the image, so `verify`
// works anywhere.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'v1');

type Schema = Record<string, any>;

const cache = new Map<string, Schema>();

export function schema(name: string): Schema {
  let s = cache.get(name);
  if (!s) {
    s = JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), 'utf8')) as Schema;
    cache.set(name, s);
  }
  return s;
}

export function schemaNames(): string[] {
  return readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .map((f) => f.slice(0, -'.schema.json'.length))
    .sort();
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected: string, actual: string): boolean {
  return expected === actual || (expected === 'number' && actual === 'integer');
}

/** Returns readable errors; empty when the value is valid. */
export function validate(s: Schema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(t, typeOf(value)))) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if ('const' in s && value !== s.const) errors.push(`${path}: expected ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${s.enum.join(', ')}`);
  if (typeof value === 'string' && s.pattern && !new RegExp(s.pattern, 'u').test(value)) errors.push(`${path}: '${value}' does not match ${s.pattern}`);
  if (typeof value === 'number' && typeof s.minimum === 'number' && value < s.minimum) errors.push(`${path}: ${value} is below ${s.minimum}`);
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
    if (s.items) value.forEach((v, i) => errors.push(...validate(s.items, v, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in obj)) errors.push(`${path}: missing required '${r}'`);
    for (const [k, sub] of Object.entries<Schema>(s.properties ?? {})) if (k in obj) errors.push(...validate(sub, obj[k], `${path}.${k}`));
    if (s.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!(k in (s.properties ?? {}))) errors.push(`${path}: unexpected '${k}'`);
    }
  }
  return errors;
}
