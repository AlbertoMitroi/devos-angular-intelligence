// Canonical JSON (keys sorted ordinally, no whitespace) and content-hash ids (contract: Identity, D7 of dotnet-intelligence).
import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in canonical JSON');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => canonical(v)).join(',') + ']';
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => ordinal(a, b));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  }
  throw new Error(`unsupported value in canonical JSON: ${typeof value}`);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `{prefix}:{first 32 hex of SHA-256 of the canonical identifying fields}`. */
export function recordId(prefix: string, fields: unknown): string {
  return `${prefix}:${sha256Hex(canonical(fields)).slice(0, 32)}`;
}

export function compareOrdinal(a: string, b: string): number {
  return ordinal(a, b);
}

/** Git blob id (SHA-1 object format) of the given bytes. */
export function gitBlobId(bytes: Uint8Array, objectFormat: 'sha1' | 'sha256' = 'sha1'): string {
  const hash = createHash(objectFormat === 'sha256' ? 'sha256' : 'sha1');
  hash.update(`blob ${bytes.length}\0`);
  hash.update(bytes);
  return hash.digest('hex');
}
