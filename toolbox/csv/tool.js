#!/usr/bin/env node
// Inspired by PapaParse (MIT); reimplemented from the RFC 4180 spec (with the
// common CRLF/LF-either-way and ragged-row tolerance most real-world CSV
// parsers add on top of the strict RFC).
//
// Two modes on one stdin/stdout JSON object:
//   parse:     { mode: "parse", text, delimiter?, header? } -> { rows, columns?, warnings, truncated }
//   stringify: { mode: "stringify", rows, columns?, delimiter? } -> { text }
//
// parse caps the returned rows at MAX_ROWS (20,000), setting truncated:true
// if the source had more, so an ordinary-looking but huge CSV can't blow the
// runner's 1MB stdout cap. stringify always terminates its output with a
// trailing line terminator (matching how most real CSV writers, e.g.
// Python's csv module, behave) — without it, a fully-empty trailing row
// serialises to zero bytes and is indistinguishable from "no such row",
// silently dropping it on the next parse.
'use strict';

const MAX_ROWS = 20_000;

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * RFC 4180 field/record state machine, extended to tolerate either CRLF or
 * bare LF line endings (real-world CSV mixes both) and to allow a quote to
 * open a field only when it is the first character of that field — any other
 * quote is a literal character, matching how PapaParse and Excel behave on
 * malformed input rather than throwing.
 *
 * Returns { rows: string[][], unterminatedQuoteRow: number|null } — rows are
 * always arrays of arrays (header handling happens one layer up);
 * unterminatedQuoteRow is the 0-based record index of a quoted field that
 * was still open at end of input, or null.
 */
function parseRecords(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldHadOpenQuote = false;
  let quoteOpenedInRow = null;
  const n = text.length;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
    fieldHadOpenQuote = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
      continue;
    }
    if (c === '"' && field.length === 0 && !fieldHadOpenQuote) {
      inQuotes = true;
      fieldHadOpenQuote = true;
      quoteOpenedInRow = rows.length;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      endRow();
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\r') {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Trailing data: only flush a final record if the source text does NOT
  // itself end with a newline — every newline the loop above encountered
  // already closed its row (including a genuinely empty trailing row, e.g.
  // two consecutive terminators). Keying this off the actual trailing
  // newline in the source (rather than just "is something pending?") makes
  // the invariant explicit: a source that ends mid-record (no terminator)
  // always has one more record to flush, full stop — even if that record
  // is empty (e.g. an empty `text` still yields zero rows here because
  // there is nothing pending either way).
  //
  // A quoted field still open at end of input swallowed everything after its
  // opening quote — including any trailing newline, which then belongs to the
  // field rather than terminating a record — so that record is always
  // flushed (never silently dropped) and reported to the caller.
  if (inQuotes) {
    endRow();
    return { rows, unterminatedQuoteRow: quoteOpenedInRow };
  }
  const endsWithNewline = n > 0 && (text[n - 1] === '\n' || text[n - 1] === '\r');
  if (!endsWithNewline && (field.length > 0 || row.length > 0)) {
    endRow();
  }
  return { rows, unterminatedQuoteRow: null };
}

function dedupeHeader(names) {
  // Every original name is reserved up front, so a generated "a_1" can never
  // collide with a real "a_1" column elsewhere in the header (which would
  // silently overwrite one column's data with another's).
  const original = new Set(names);
  const taken = new Set();
  const nextSuffix = new Map();
  const warnings = [];
  const out = names.map((name) => {
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
    let k = nextSuffix.get(name) ?? 1;
    while (taken.has(`${name}_${k}`) || original.has(`${name}_${k}`)) k += 1;
    nextSuffix.set(name, k + 1);
    const deduped = `${name}_${k}`;
    taken.add(deduped);
    warnings.push(`duplicate header "${name}" renamed to "${deduped}"`);
    return deduped;
  });
  return { columns: out, warnings };
}

function parseCsv(text, delimiter, header) {
  const { rows: records, unterminatedQuoteRow } = parseRecords(text, delimiter);
  const warnings = [];
  if (unterminatedQuoteRow !== null) {
    warnings.push(`row ${unterminatedQuoteRow}: unterminated quoted field (missing closing quote); the rest of the input was read into that field`);
  }
  if (records.length === 0) {
    return header ? { rows: [], columns: [], warnings, truncated: false } : { rows: [], warnings, truncated: false };
  }

  if (!header) {
    const width = records[0].length;
    const truncated = records.length > MAX_ROWS;
    const limited = truncated ? records.slice(0, MAX_ROWS) : records;
    limited.forEach((r, idx) => {
      if (r.length !== width) {
        warnings.push(`row ${idx}: expected ${width} field(s), got ${r.length}`);
      }
    });
    return { rows: limited, warnings, truncated };
  }

  const { columns, warnings: headerWarnings } = dedupeHeader(records[0]);
  warnings.push(...headerWarnings);
  const dataRecords = records.slice(1);
  const truncated = dataRecords.length > MAX_ROWS;
  const limited = truncated ? dataRecords.slice(0, MAX_ROWS) : dataRecords;
  const rows = limited.map((r, idx) => {
    if (r.length !== columns.length) {
      warnings.push(`row ${idx + 1}: expected ${columns.length} field(s), got ${r.length}`);
    }
    // A plain {} would treat a "__proto__" column specially — obj['__proto__'] = v
    // sets the object's prototype instead of an own property (and silently
    // no-ops for a string value), so the column's data would vanish from
    // the output instead of round-tripping. A null-prototype object has no
    // such special accessor, so "__proto__" behaves like any other key.
    const obj = Object.create(null);
    columns.forEach((col, colIdx) => {
      obj[col] = colIdx < r.length ? r[colIdx] : null;
    });
    return obj;
  });
  return { rows, columns, warnings, truncated };
}

const NEEDS_QUOTE_RE_SOURCE = (delimiter) => `["\r\n]|^\\s|\\s$|${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;

function quoteField(value, delimiter) {
  const s = value === null || value === undefined ? '' : String(value);
  const needsQuote = new RegExp(NEEDS_QUOTE_RE_SOURCE(delimiter)).test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function stringifyCsv(rows, columns, delimiter) {
  if (!Array.isArray(rows)) throw new Error('rows must be an array');
  if (rows.length === 0) {
    if (!columns || columns.length === 0) return '';
    return columns.map((c) => quoteField(c, delimiter)).join(delimiter) + '\r\n';
  }

  const firstIsObject = rows[0] !== null && typeof rows[0] === 'object' && !Array.isArray(rows[0]);
  const lines = [];

  if (firstIsObject) {
    let cols = columns;
    if (!cols || cols.length === 0) {
      const seen = new Set();
      cols = [];
      for (const r of rows) {
        for (const k of Object.keys(r)) {
          if (!seen.has(k)) {
            seen.add(k);
            cols.push(k);
          }
        }
      }
    }
    lines.push(cols.map((c) => quoteField(c, delimiter)).join(delimiter));
    for (const r of rows) {
      if (r === null || typeof r !== 'object' || Array.isArray(r)) {
        throw new Error('each row must be an object when rows[0] is an object');
      }
      // Own keys only: a column named e.g. "toString" that a row lacks must
      // be empty, not the inherited Object.prototype function's source text.
      lines.push(cols.map((c) => quoteField(Object.hasOwn(r, c) ? r[c] : undefined, delimiter)).join(delimiter));
    }
  } else {
    if (columns && columns.length) {
      lines.push(columns.map((c) => quoteField(c, delimiter)).join(delimiter));
    }
    for (const r of rows) {
      if (!Array.isArray(r)) throw new Error('each row must be an array when rows[0] is an array');
      lines.push(r.map((v) => quoteField(v, delimiter)).join(delimiter));
    }
  }
  // Always terminate the last line too. Without this, a fully-empty
  // trailing row (or a lone empty-string row) serialises to zero
  // additional bytes and becomes indistinguishable, on the next parse,
  // from "no such row" — silently dropping it. See parseRecords' matching
  // trailing-newline-keyed guard, which relies on every real row (including
  // an empty one) being newline-terminated in the source it reads.
  return lines.join('\r\n') + '\r\n';
}

async function main() {
  const raw = await readStdin();
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch (err) {
    return fail(`invalid JSON on stdin: ${err.message}`);
  }
  if (args === null || typeof args !== 'object') return fail('input must be a JSON object');

  const mode = args.mode;
  if (mode !== 'parse' && mode !== 'stringify') return fail('mode must be "parse" or "stringify"');

  const delimiter = args.delimiter === undefined ? ',' : args.delimiter;
  if (typeof delimiter !== 'string' || delimiter.length !== 1) return fail('delimiter must be a single character');
  if (delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    return fail('delimiter cannot be a double quote, CR or LF (they already have meaning in CSV)');
  }

  if (mode === 'parse') {
    if (typeof args.text !== 'string') return fail('text must be a string for mode "parse"');
    const header = Boolean(args.header);
    // Drop a leading UTF-8 byte-order mark (Excel and many Windows tools write
    // one); otherwise it becomes part of the first header/field's text.
    const text = args.text.charCodeAt(0) === 0xfeff ? args.text.slice(1) : args.text;
    const result = parseCsv(text, delimiter, header);
    process.stdout.write(JSON.stringify(result));
    return;
  }

  // stringify
  if (!Array.isArray(args.rows)) return fail('rows must be an array for mode "stringify"');
  const columns = args.columns === undefined ? undefined : args.columns;
  if (columns !== undefined && !Array.isArray(columns)) return fail('columns must be an array of strings');
  try {
    const text = stringifyCsv(args.rows, columns, delimiter);
    process.stdout.write(JSON.stringify({ text }));
  } catch (err) {
    return fail(err.message);
  }
}

main().catch((err) => fail(`unexpected error: ${err.message}`));
