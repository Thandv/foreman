/**
 * A deliberately small JSON-Schema subset: object/array/string/number/integer/
 * boolean/null, `required`, `enum`, `items`, `properties`, and the length and
 * range keywords. Enough to describe a tool's contract; small enough to read in
 * one sitting and to keep Foreman dependency-free.
 */
export interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
  description?: string;
}

const typeOf = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
};

const matches = (actual: string, want: string): boolean =>
  actual === want || (want === 'number' && actual === 'integer');

/** Returns a list of human-readable problems; empty means valid. */
export function validate(value: unknown, schema: Schema, path = '$'): string[] {
  const problems: string[] = [];
  if (!schema || typeof schema !== 'object') return problems;

  if (schema.type) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!wanted.some((w) => matches(actual, w))) {
      return [`${path}: expected ${wanted.join(' or ')}, got ${actual}`];
    }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    problems.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => problems.push(...validate(v, schema.items!, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) problems.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) problems.push(...validate(obj[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) problems.push(`${path}.${key}: not allowed by the schema`);
      }
    }
  }
  return problems;
}

/** Compact rendering used in tool-surface prompts, so models see the contract. */
export function describe(schema: Schema): string {
  if (!schema?.type && !schema?.properties) return 'any';
  if (schema.type === 'object' || schema.properties) {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {}).map(
      ([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${describe(v)}`,
    );
    return `{${fields.join(', ')}}`;
  }
  if (schema.type === 'array') return `${describe(schema.items ?? {})}[]`;
  return Array.isArray(schema.type) ? schema.type.join('|') : String(schema.type ?? 'any');
}
