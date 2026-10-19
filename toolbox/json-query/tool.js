#!/usr/bin/env node
// Inspired by jmespath.js (Apache-2.0); reimplemented from the published
// JMESPath grammar/spec — no vendored code. This implements a SUBSET: dot
// access, [n] index (incl. negative), [*] and .* wildcard projection, []
// flatten projection, [?cond] filter projection with == != < <= > >= && ||
// !, pipes (|) that reset projection scope, multiselect hashes {a: x, b:
// y}, and the functions length/keys/values/sort_by/max_by/min_by/contains/
// starts_with/join/to_number. No slices, no full multiselect-list, no
// raw '&&'/'||' short-circuit function refs beyond the &expr form used by
// sort_by/max_by/min_by. Unsupported syntax is a parse error, not silent
// misbehaviour.
//
// stdin: { data: any, query: string }
// stdout: { result: any, truncated: boolean }
//
// Two bounds keep this tool from producing pathological runtime or output:
//  - the recursive-descent parser caps expression nesting (parens, function
//    args, filter conditions, multiselect-hash values) at MAX_QUERY_DEPTH,
//    refusing deeper queries with a clean "nesting too deep" error instead
//    of blowing the call stack;
//  - the serialized result is capped at MAX_RESULT_CHARS; an oversized
//    array result is truncated to the largest prefix that still fits, with
//    a trailing marker object noting how much was cut, so an ordinary query
//    against a huge document can't exceed the runner's 1MB stdout cap.
'use strict';

const MAX_QUERY_DEPTH = 200;
const MAX_RESULT_CHARS = 700_000;

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

class QueryError extends Error {}

// --- lexer ------------------------------------------------------------
const STOP_AT_EOF = Symbol('eof');

function isIdentStart(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isIdentChar(c) {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}
function isDigit(c) {
  return c >= '0' && c <= '9';
}

function lex(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  const push = (type, value, pos) => tokens.push({ type, value, pos });

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    const start = i;
    if (c === '.') { push('DOT', '.', start); i += 1; continue; }
    if (c === '*') { push('STAR', '*', start); i += 1; continue; }
    if (c === ',') { push('COMMA', ',', start); i += 1; continue; }
    if (c === ':') { push('COLON', ':', start); i += 1; continue; }
    if (c === '(') { push('LPAREN', '(', start); i += 1; continue; }
    if (c === ')') { push('RPAREN', ')', start); i += 1; continue; }
    if (c === '{') { push('LBRACE', '{', start); i += 1; continue; }
    if (c === '}') { push('RBRACE', '}', start); i += 1; continue; }
    if (c === '@') { push('AT', '@', start); i += 1; continue; }
    if (c === '[') {
      if (src[i + 1] === ']') { push('FLATTEN', '[]', start); i += 2; continue; }
      if (src[i + 1] === '?') { push('FILTER_START', '[?', start); i += 2; continue; }
      push('LBRACKET', '[', start); i += 1; continue;
    }
    if (c === ']') { push('RBRACKET', ']', start); i += 1; continue; }
    if (c === '|') {
      if (src[i + 1] === '|') { push('OR', '||', start); i += 2; continue; }
      push('PIPE', '|', start); i += 1; continue;
    }
    if (c === '&') {
      if (src[i + 1] === '&') { push('AND', '&&', start); i += 2; continue; }
      push('AMP', '&', start); i += 1; continue;
    }
    if (c === '!') {
      if (src[i + 1] === '=') { push('NE', '!=', start); i += 2; continue; }
      push('NOT', '!', start); i += 1; continue;
    }
    if (c === '=') {
      if (src[i + 1] === '=') { push('EQ', '==', start); i += 2; continue; }
      throw new QueryError(`unexpected '=' at position ${start} (did you mean '=='?)`);
    }
    if (c === '<') {
      if (src[i + 1] === '=') { push('LE', '<=', start); i += 2; continue; }
      push('LT', '<', start); i += 1; continue;
    }
    if (c === '>') {
      if (src[i + 1] === '=') { push('GE', '>=', start); i += 2; continue; }
      push('GT', '>', start); i += 1; continue;
    }
    if (c === '-' && isDigit(src[i + 1])) {
      let j = i + 1;
      while (j < n && isDigit(src[j])) j += 1;
      push('NUMBER', Number(src.slice(i, j)), start);
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i;
      while (j < n && isDigit(src[j])) j += 1;
      push('NUMBER', Number(src.slice(i, j)), start);
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) { value += src[j + 1]; j += 2; continue; }
        value += src[j];
        j += 1;
      }
      if (j >= n) throw new QueryError(`unterminated quoted identifier starting at position ${start}`);
      push('QUOTED_IDENT', value, start);
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let value = '';
      while (j < n && src[j] !== "'") {
        // JMESPath raw strings only unescape \' and \\; any other backslash
        // is kept literally ('a\b' is the three characters a, \, b).
        if (src[j] === '\\' && (src[j + 1] === "'" || src[j + 1] === '\\')) { value += src[j + 1]; j += 2; continue; }
        value += src[j];
        j += 1;
      }
      if (j >= n) throw new QueryError(`unterminated string literal starting at position ${start}`);
      push('RAW_STRING', value, start);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let raw = '';
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\' && j + 1 < n) { raw += src[j + 1]; j += 2; continue; }
        raw += src[j];
        j += 1;
      }
      if (j >= n) throw new QueryError(`unterminated literal starting at position ${start}`);
      let value;
      try {
        value = JSON.parse(raw);
      } catch (err) {
        throw new QueryError(`invalid JSON literal at position ${start}: ${err.message}`);
      }
      push('LITERAL', value, start);
      i = j + 1;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentChar(src[j])) j += 1;
      push('IDENT', src.slice(i, j), start);
      i = j;
      continue;
    }
    throw new QueryError(`unexpected character '${c}' at position ${start}`);
  }
  push('EOF', null, n);
  return tokens;
}

// --- parser (recursive descent, projection-aware) -----------------------
const CHAIN_STOP = new Set(['PIPE', 'OR', 'AND', 'RPAREN', 'RBRACKET', 'RBRACE', 'COMMA', 'EOF', 'EQ', 'NE', 'LT', 'LE', 'GT', 'GE', 'COLON']);

class Parser {
  constructor(tokens, src) {
    this.tokens = tokens;
    this.src = src;
    this.pos = 0;
    this.exprDepth = 0;
  }

  peek() { return this.tokens[this.pos]; }

  next() { return this.tokens[this.pos++]; }

  expect(type) {
    const t = this.next();
    if (t.type !== type) {
      throw new QueryError(`expected ${type} but found '${t.value ?? t.type}' at position ${t.pos}`);
    }
    return t;
  }

  parse() {
    const node = this.parsePipe();
    const t = this.peek();
    if (t.type !== 'EOF') throw new QueryError(`unexpected trailing input '${t.value ?? t.type}' at position ${t.pos}`);
    return node;
  }

  parsePipe() {
    let left = this.parseOr();
    while (this.peek().type === 'PIPE') {
      this.next();
      const right = this.parseOr();
      left = { type: 'Pipe', left, right };
    }
    return left;
  }

  // Every recursive re-entry into an expression (parenthesised
  // sub-expression, function-call argument, filter condition, multiselect-
  // hash value) goes through parseOr, so guarding depth here catches all of
  // them without having to duplicate the check at each call site.
  parseOr() {
    this.exprDepth += 1;
    if (this.exprDepth > MAX_QUERY_DEPTH) {
      const t = this.peek();
      throw new QueryError(`query nesting too deep (over ${MAX_QUERY_DEPTH} levels) near position ${t.pos}`);
    }
    try {
      let left = this.parseAnd();
      while (this.peek().type === 'OR') {
        this.next();
        const right = this.parseAnd();
        left = { type: 'Or', left, right };
      }
      return left;
    } finally {
      this.exprDepth -= 1;
    }
  }

  parseAnd() {
    let left = this.parseCompare();
    while (this.peek().type === 'AND') {
      this.next();
      const right = this.parseCompare();
      left = { type: 'And', left, right };
    }
    return left;
  }

  // `!` binds tighter than the comparators (as in JMESPath): `!a == b` is
  // `(!a) == b`, not `!(a == b)`.
  parseNot() {
    if (this.peek().type === 'NOT') {
      this.next();
      return { type: 'Not', node: this.parseNot() };
    }
    return this.parseChain();
  }

  parseCompare() {
    const left = this.parseNot();
    const t = this.peek();
    const CMP = { EQ: '==', NE: '!=', LT: '<', LE: '<=', GT: '>', GE: '>=' };
    if (CMP[t.type]) {
      this.next();
      const right = this.parseNot();
      return { type: 'Compare', op: CMP[t.type], left, right };
    }
    return left;
  }

  // The base of a fresh chain (an implicit `@`).
  parseChain() {
    const left = this.parsePrimary();
    return this.parseChainTail(left);
  }

  // `inProjection` is true while parsing the per-element RHS of a projection.
  // There a `[]` ends the RHS instead of being consumed by it: in JMESPath a
  // flatten binds looser than every other projection, so `a[*].b[]` and
  // `a[].b[]` flatten the WHOLE projected list (`[[1,2],[3]]` -> `[1,2,3]`),
  // not each element's `b` on its own. The outermost chain (inProjection
  // false) then wraps everything parsed so far in that flatten and goes on.
  parseChainTail(leftIn, inProjection = false) {
    // A chain of simple `.field`/`[n]` links loops (no recursion, no depth
    // cost). A chained projection (`[]`, `[*]`, `[?..]`) recurses through
    // parseProjectionRhs back into parseChainTail for whatever follows it —
    // e.g. `a[?x][?y][?z]...` repeated thousands of times — which DOES grow
    // the real call stack one frame per link, independent of parseOr's own
    // depth guard (each individual filter condition's parseOr call returns
    // before the next filter is even parsed). Guard that recursion here.
    this.exprDepth += 1;
    if (this.exprDepth > MAX_QUERY_DEPTH) {
      const t = this.peek();
      throw new QueryError(`query nesting too deep (over ${MAX_QUERY_DEPTH} levels) near position ${t.pos}`);
    }
    try {
      let left = leftIn;
      for (;;) {
        const t = this.peek();
        if (t.type === 'DOT') {
          this.next();
          const t2 = this.peek();
          if (t2.type === 'STAR') {
            this.next();
            const rhs = this.parseProjectionRhs();
            left = { type: 'ObjectWildcardProjection', source: left, rhs };
            if (inProjection) return left;
            continue;
          }
          const name = this.parseFieldName();
          left = { type: 'Field', name, source: left };
          continue;
        }
        if (t.type === 'FLATTEN') {
          if (inProjection) break; // the enclosing chain applies this flatten
          this.next();
          const rhs = this.parseProjectionRhs();
          left = { type: 'FlattenProjection', source: left, rhs };
          continue;
        }
        if (t.type === 'FILTER_START') {
          this.next();
          const condition = this.parseOr();
          this.expect('RBRACKET');
          const rhs = this.parseProjectionRhs();
          left = { type: 'FilterProjection', source: left, condition, rhs };
          if (inProjection) return left;
          continue;
        }
        if (t.type === 'LBRACKET') {
          this.next();
          if (this.peek().type === 'STAR') {
            this.next();
            this.expect('RBRACKET');
            const rhs = this.parseProjectionRhs();
            left = { type: 'WildcardProjection', source: left, rhs };
            if (inProjection) return left;
            continue;
          }
          const idxTok = this.expect('NUMBER');
          this.expect('RBRACKET');
          left = { type: 'Index', index: idxTok.value, source: left };
          continue;
        }
        break;
      }
      return left;
    } finally {
      this.exprDepth -= 1;
    }
  }

  /** The expression applied per-element after a projection. Stops at a
   * pipe / boolean op / closing bracket / comma / EOF, exactly the tokens
   * that mean "the projection's scope ends here". */
  parseProjectionRhs() {
    const t = this.peek();
    if (CHAIN_STOP.has(t.type) || t.type === 'FLATTEN') return { type: 'Identity' };
    if (t.type === 'DOT' || t.type === 'FILTER_START' || t.type === 'LBRACKET') {
      return this.parseChainTail({ type: 'Identity' }, true);
    }
    throw new QueryError(`unexpected token '${t.value ?? t.type}' at position ${t.pos} after a projection`);
  }

  parseFieldName() {
    const t = this.next();
    if (t.type === 'IDENT' || t.type === 'QUOTED_IDENT') return t.value;
    throw new QueryError(`expected a field name after '.' but found '${t.value ?? t.type}' at position ${t.pos}`);
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'AT') { this.next(); return { type: 'Identity' }; }
    if (t.type === 'STAR') {
      this.next();
      const rhs = this.parseProjectionRhs();
      return { type: 'ObjectWildcardProjection', source: { type: 'Identity' }, rhs };
    }
    if (t.type === 'LBRACKET' || t.type === 'FLATTEN' || t.type === 'FILTER_START') {
      return { type: 'Identity' }; // let parseChainTail consume the bracket
    }
    if (t.type === 'LITERAL') { this.next(); return { type: 'Literal', value: t.value }; }
    if (t.type === 'RAW_STRING') { this.next(); return { type: 'Literal', value: t.value }; }
    if (t.type === 'LPAREN') {
      this.next();
      const node = this.parsePipe();
      this.expect('RPAREN');
      return node;
    }
    if (t.type === 'LBRACE') return this.parseMultiSelectHash();
    if (t.type === 'IDENT') {
      this.next();
      if (this.peek().type === 'LPAREN') return this.parseFunctionCall(t.value);
      return { type: 'Field', name: t.value, source: { type: 'Identity' } };
    }
    if (t.type === 'QUOTED_IDENT') {
      this.next();
      return { type: 'Field', name: t.value, source: { type: 'Identity' } };
    }
    throw new QueryError(`unexpected token '${t.value ?? t.type}' at position ${t.pos}`);
  }

  parseMultiSelectHash() {
    this.expect('LBRACE');
    const pairs = [];
    if (this.peek().type !== 'RBRACE') {
      for (;;) {
        const keyTok = this.next();
        if (keyTok.type !== 'IDENT' && keyTok.type !== 'QUOTED_IDENT') {
          throw new QueryError(`expected a key name in multiselect hash but found '${keyTok.value ?? keyTok.type}' at position ${keyTok.pos}`);
        }
        this.expect('COLON');
        const valueNode = this.parseOr();
        pairs.push({ key: keyTok.value, node: valueNode });
        if (this.peek().type === 'COMMA') { this.next(); continue; }
        break;
      }
    }
    this.expect('RBRACE');
    return { type: 'MultiSelectHash', pairs };
  }

  parseFunctionCall(name) {
    this.expect('LPAREN');
    const args = [];
    if (this.peek().type !== 'RPAREN') {
      for (;;) {
        if (this.peek().type === 'AMP') {
          this.next();
          args.push({ type: 'ExprRef', node: this.parseOr() });
        } else {
          args.push(this.parseOr());
        }
        if (this.peek().type === 'COMMA') { this.next(); continue; }
        break;
      }
    }
    const closeTok = this.peek();
    this.expect('RPAREN');
    return { type: 'FunctionCall', name, args, pos: closeTok.pos };
  }
}

function parseQuery(query) {
  const tokens = lex(query);
  const parser = new Parser(tokens, query);
  return parser.parse();
}

// --- evaluator ------------------------------------------------------------
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function truthy(v) {
  if (v === false || v === null || v === undefined) return false;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return true; // numbers (incl. 0) and true are truthy, per JMESPath semantics
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (!(k in b) || !deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

function compareValues(op, l, r) {
  if (op === '==') return deepEqual(l, r);
  if (op === '!=') return !deepEqual(l, r);
  if (typeof l !== 'number' || typeof r !== 'number') return false;
  if (op === '<') return l < r;
  if (op === '<=') return l <= r;
  if (op === '>') return l > r;
  return l >= r;
}

function evaluate(node, value) {
  switch (node.type) {
    case 'Identity':
      return value;
    case 'Literal':
      return node.value;
    case 'Field': {
      const base = evaluate(node.source, value);
      if (!isPlainObject(base)) return null;
      return Object.prototype.hasOwnProperty.call(base, node.name) ? base[node.name] : null;
    }
    case 'Index': {
      const base = evaluate(node.source, value);
      if (!Array.isArray(base)) return null;
      let idx = node.index;
      if (idx < 0) idx += base.length;
      return idx >= 0 && idx < base.length ? base[idx] : null;
    }
    case 'WildcardProjection':
    case 'ObjectWildcardProjection': {
      const base = evaluate(node.source, value);
      if (base === null) return null;
      const items = Array.isArray(base) ? base : (isPlainObject(base) ? Object.values(base) : null);
      if (items === null) return null;
      const out = [];
      for (const item of items) {
        const r = evaluate(node.rhs, item);
        if (r !== null && r !== undefined) out.push(r);
      }
      return out;
    }
    case 'FlattenProjection': {
      const base = evaluate(node.source, value);
      if (!Array.isArray(base)) return null;
      const flat = [];
      for (const item of base) {
        if (Array.isArray(item)) flat.push(...item);
        else flat.push(item);
      }
      const out = [];
      for (const item of flat) {
        const r = evaluate(node.rhs, item);
        if (r !== null && r !== undefined) out.push(r);
      }
      return out;
    }
    case 'FilterProjection': {
      const base = evaluate(node.source, value);
      if (!Array.isArray(base)) return null;
      const out = [];
      for (const item of base) {
        if (!truthy(evaluate(node.condition, item))) continue;
        const r = evaluate(node.rhs, item);
        if (r !== null && r !== undefined) out.push(r);
      }
      return out;
    }
    case 'Pipe': {
      const left = evaluate(node.left, value);
      return evaluate(node.right, left);
    }
    case 'Or': {
      const left = evaluate(node.left, value);
      return truthy(left) ? left : evaluate(node.right, value);
    }
    case 'And': {
      const left = evaluate(node.left, value);
      return truthy(left) ? evaluate(node.right, value) : left;
    }
    case 'Not':
      return !truthy(evaluate(node.node, value));
    case 'Compare':
      return compareValues(node.op, evaluate(node.left, value), evaluate(node.right, value));
    case 'MultiSelectHash': {
      const out = Object.create(null); // a "__proto__" key must stay an ordinary key
      for (const { key, node: valNode } of node.pairs) out[key] = evaluate(valNode, value);
      return out;
    }
    case 'FunctionCall':
      return callFunction(node, value);
    case 'ExprRef':
      throw new QueryError('an &expression may only appear as a function argument');
    default:
      throw new QueryError(`internal error: unknown node type '${node.type}'`);
  }
}

function requireArgs(node, count) {
  if (node.args.length !== count) {
    throw new QueryError(`${node.name}() expects ${count} argument${count === 1 ? '' : 's'}, got ${node.args.length} (near position ${node.pos})`);
  }
}

function exprRefAsFn(argNode) {
  if (argNode.type !== 'ExprRef') throw new QueryError('expected an &expression argument (e.g. &field)');
  return (el) => evaluate(argNode.node, el);
}

function callFunction(node, value) {
  const { name, args } = node;
  switch (name) {
    case 'length': {
      requireArgs(node, 1);
      const v = evaluate(args[0], value);
      if (typeof v === 'string' || Array.isArray(v)) return v.length;
      if (isPlainObject(v)) return Object.keys(v).length;
      throw new QueryError(`length() requires a string, array or object (near position ${node.pos})`);
    }
    case 'keys': {
      requireArgs(node, 1);
      const v = evaluate(args[0], value);
      if (!isPlainObject(v)) throw new QueryError(`keys() requires an object (near position ${node.pos})`);
      return Object.keys(v);
    }
    case 'values': {
      requireArgs(node, 1);
      const v = evaluate(args[0], value);
      if (!isPlainObject(v)) throw new QueryError(`values() requires an object (near position ${node.pos})`);
      return Object.values(v);
    }
    case 'sort_by': {
      requireArgs(node, 2);
      const arr = evaluate(args[0], value);
      if (!Array.isArray(arr)) throw new QueryError(`sort_by() requires an array as its first argument (near position ${node.pos})`);
      const keyFn = exprRefAsFn(args[1]);
      const decorated = arr.map((el, idx) => ({ el, key: keyFn(el), idx }));
      decorated.forEach(({ key }) => {
        if (typeof key !== 'number' && typeof key !== 'string') {
          throw new QueryError(`sort_by() key expression must evaluate to a number or string (near position ${node.pos})`);
        }
        // Mixed numbers and strings have no consistent order under JS's < / >
        // (it coerces), so the "sorted" output would depend on input order.
        if (typeof key !== typeof decorated[0].key) {
          throw new QueryError(`sort_by() keys must all be numbers or all be strings, not a mix (near position ${node.pos})`);
        }
      });
      decorated.sort((a, b) => {
        if (a.key < b.key) return -1;
        if (a.key > b.key) return 1;
        return a.idx - b.idx; // stable
      });
      return decorated.map((d) => d.el);
    }
    case 'max_by':
    case 'min_by': {
      requireArgs(node, 2);
      const arr = evaluate(args[0], value);
      if (!Array.isArray(arr)) throw new QueryError(`${name}() requires an array as its first argument (near position ${node.pos})`);
      if (arr.length === 0) return null;
      const keyFn = exprRefAsFn(args[1]);
      // Same key-type check as sort_by(): without it, a key expression that
      // evaluates to e.g. an object or array falls through to JS's `>`/`<`,
      // which coerces both sides to primitives (often "[object Object]")
      // and silently returns a meaningless comparison instead of erroring.
      let best = arr[0];
      let bestKey = keyFn(arr[0]);
      const checkKey = (k) => {
        if (typeof k !== 'number' && typeof k !== 'string') {
          throw new QueryError(`${name}() key expression must evaluate to a number or string (near position ${node.pos})`);
        }
        if (typeof k !== typeof bestKey) {
          throw new QueryError(`${name}() keys must all be numbers or all be strings, not a mix (near position ${node.pos})`);
        }
      };
      checkKey(bestKey);
      for (let i = 1; i < arr.length; i += 1) {
        const k = keyFn(arr[i]);
        checkKey(k);
        const better = name === 'max_by' ? k > bestKey : k < bestKey;
        if (better) { best = arr[i]; bestKey = k; }
      }
      return best;
    }
    case 'contains': {
      requireArgs(node, 2);
      const haystack = evaluate(args[0], value);
      const needle = evaluate(args[1], value);
      if (typeof haystack === 'string') return typeof needle === 'string' && haystack.includes(needle);
      if (Array.isArray(haystack)) return haystack.some((el) => deepEqual(el, needle));
      throw new QueryError(`contains() requires a string or array as its first argument (near position ${node.pos})`);
    }
    case 'starts_with': {
      requireArgs(node, 2);
      const s = evaluate(args[0], value);
      const prefix = evaluate(args[1], value);
      if (typeof s !== 'string' || typeof prefix !== 'string') {
        throw new QueryError(`starts_with() requires two strings (near position ${node.pos})`);
      }
      return s.startsWith(prefix);
    }
    case 'join': {
      requireArgs(node, 2);
      const sep = evaluate(args[0], value);
      const arr = evaluate(args[1], value);
      if (typeof sep !== 'string') throw new QueryError(`join() requires a string separator (near position ${node.pos})`);
      if (!Array.isArray(arr) || !arr.every((el) => typeof el === 'string')) {
        throw new QueryError(`join() requires an array of strings (near position ${node.pos})`);
      }
      return arr.join(sep);
    }
    case 'to_number': {
      requireArgs(node, 1);
      const v = evaluate(args[0], value);
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return null;
    }
    default:
      throw new QueryError(`unknown function '${name}()' (near position ${node.pos})`);
  }
}

/**
 * Bounds the serialized result to MAX_RESULT_CHARS. Array results are
 * truncated to the largest prefix (found by binary search on the
 * serialized length) that still fits alongside a trailing marker object
 * describing how much was cut. A non-array result that is still oversized
 * (e.g. one enormous string) can't be meaningfully "truncated element by
 * element", so it is replaced outright by a marker — rare, but still must
 * never exceed the runner's 1MB stdout cap.
 */
function boundResult(result) {
  const full = JSON.stringify(result);
  if (full !== undefined && full.length <= MAX_RESULT_CHARS) return { result, truncated: false };

  if (!Array.isArray(result)) {
    return {
      result: { truncated: true, note: `result exceeded ${MAX_RESULT_CHARS} characters and is not an array; omitted` },
      truncated: true,
    };
  }

  let lo = 0;
  let hi = result.length;
  const fits = (count) => {
    const marker = { truncated: true, originalLength: result.length, returned: count };
    return JSON.stringify([...result.slice(0, count), marker]).length <= MAX_RESULT_CHARS;
  };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const marker = { truncated: true, originalLength: result.length, returned: lo };
  return { result: [...result.slice(0, lo), marker], truncated: true };
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
  if (!('data' in args)) return fail('data is required');
  if (typeof args.query !== 'string') return fail('query must be a string');

  let ast;
  try {
    ast = parseQuery(args.query);
  } catch (err) {
    return fail(err instanceof QueryError ? `query syntax error: ${err.message}` : `unexpected error: ${err.message}`);
  }

  let result;
  try {
    result = evaluate(ast, args.data);
  } catch (err) {
    return fail(err instanceof QueryError ? `query error: ${err.message}` : `unexpected error: ${err.message}`);
  }
  const bounded = boundResult(result === undefined ? null : result);
  process.stdout.write(JSON.stringify({ result: bounded.result, truncated: bounded.truncated }));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));
