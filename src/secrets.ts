// Secret detection (rule 1.4.6): by key name and by value shape (any name ending in `key` counts: over-redaction is safe). Shared by snippet redaction, config.key flags
// and destination values (D20), so a value is either stored nowhere or flagged nowhere.

const SECRET_KEY = /(pass(word|wd)?$|^pwd$|secret|token|api[-_]?key|apikey|private[-_]?key|credential|connection[-_]?string|auth[-_]?key|signing[-_]?key|^salt$|access[-_]?key|sas$|key$)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export function isSecretValue(value: string): boolean {
  if (/^eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}$/.test(value)) return true; // JWT
  if (value.includes('-----BEGIN')) return true; // PEM
  if (/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value)) return true; // URL with user:password
  if (/(^|;)\s*(password|pwd|accountkey|sharedaccesskey)\s*=/i.test(value)) return true; // connection strings
  if (/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(value)) return true;
  if (/^(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}$/.test(value)) return true;
  if (/^(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}$/.test(value)) return true;
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value)) return true; // long tokens
  return false;
}

export function isSecret(key: string | null, value: string | null): boolean {
  return (key !== null && isSecretKey(key)) || (value !== null && isSecretValue(value));
}

export const REDACTED = '[redacted]';

/**
 * Redacts string literals in one source line whose key looks secret or whose value looks like a secret.
 * Handles `key: 'value'`, `"key": "value"`, `key = 'value'` and bare literals with a secret shape.
 */
export function redactLine(line: string): string {
  let result = '';
  let i = 0;
  const literal = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = literal.exec(line)) !== null) {
    const before = line.slice(0, match.index);
    const keyMatch = /["']?([\w$.-]+)["']?\s*[:=]\s*$/.exec(before);
    const key = keyMatch ? keyMatch[1].split('.').pop()! : null;
    const value = match[2];
    const secret = isSecret(key, value) || (key !== null && /^[\w$.-]+$/.test(key) && keyMatch !== null && isSecretKey(key));
    result += line.slice(i, match.index);
    result += secret ? match[1] + REDACTED + match[1] : match[0];
    i = match.index + match[0].length;
  }
  result += line.slice(i);
  // KEY=value lines (.env style) without quotes.
  return result.replace(/^(\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*)([^'"`\s][^\s#]*)/, (whole, prefix: string, key: string, value: string) =>
    isSecret(key, value) ? prefix + REDACTED : whole,
  );
}
