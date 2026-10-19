// Ported from the author's earlier tools (the stdlib-only path taken
// when pandoc isn't available — always taken here, since this toolbox is
// offline by construction). The ZIP container itself is ported separately;
// see zip.js's header.
//
// TWO DELIBERATE DEVIATIONS FROM THE ORIGINAL:
//
//  1. The original always wrote a Copyright + "AI Disclosure" front-matter
//     page, sourced from a `BookProject`'s author/pen-name/series metadata.
//     This tool's input contract is just {title, author, language?,
//     chapters}, with no series/real-name/pen-name distinction and no
//     publishing-boilerplate text to source — so that front matter is
//     dropped. Everything that IS a reusable template — the OOXML styles
//     (Normal/Title/Heading1/Heading2/SceneBreak), the EPUB package/nav/CSS
//     skeleton, the paragraph/heading run construction, and the scene-break
//     handling — is ported 1:1.
//
//  2. The original's `_para()` took a single whole-paragraph `italic`
//     boolean and never parsed markdown emphasis inside chapter text (its
//     source chapters were plain prose). This tool's chapters are explicitly
//     markdown (`markdown` field), so this port adds real inline run
//     parsing for `**bold**` and `*italic*`/`_italic_` — reusing the same
//     non-greedy, bold-avoiding italic pattern established in
//     parse-manuscript/tool.js — so a chapter written with emphasis renders
//     with actual bold/italic runs in both formats.
//
// Scene breaks: the original recognised the exact paragraphs "⁂", "***", and
// "* * *". This port also recognises a horizontal rule ("---", 3+ dashes) —
// the marker parse-manuscript and this toolbox's manuscripts use for scene
// breaks — since chapters here are markdown.

import fs from 'node:fs';
import path from 'node:path';
import { zip } from './zip.js';

// ------------------------------------------------------------- containment

class ContainmentError extends Error {}

/** Same realpath longest-existing-prefix technique as apply-fixes/tool.js
 *  (itself adapted from src/runners/api.ts's safePath), reused here rather
 *  than shared — see toolbox/README.md on why tools duplicate rather than
 *  import each other. */
function safeRelativePath(root, rel) {
  if (path.isAbsolute(rel)) {
    throw new ContainmentError(`absolute paths are refused: ${rel}`);
  }
  const realRoot = fs.realpathSync(root);
  const resolved = path.resolve(realRoot, rel);

  // Refuse outright if the path as named is itself a symlink — dangling or
  // not. lstat (never followed) is the only way to see this: fs.existsSync
  // on a *dangling* symlink follows the link to check its target and
  // reports "does not exist", which used to make the longest-existing-
  // prefix walk below treat the link's own on-disk path as a hole to climb
  // past. The "real" path it then reconstructed was the link's own
  // (un-followed) location — inside the jail, so containment passed — while
  // the actual write later followed the link to wherever it pointed,
  // including outside the jail entirely (proven exploit). A symlink to an
  // existing file has the same shape of problem in miniature: its target
  // could be swapped out from under the tool between this check and the
  // write. Neither case is something this tool ever needs to do, so any
  // symlink at the final path component is refused before anything else.
  const namedLstat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (namedLstat && namedLstat.isSymbolicLink()) {
    throw new ContainmentError(`refusing to write through a symlink: ${rel}`);
  }

  const tail = [];
  let existing = resolved;
  // lstat, not existsSync: keeps the same "does the link itself exist"
  // semantics as the check above for every ancestor this walk climbs past,
  // so a dangling symlink one directory up can't reopen the same hole.
  while (fs.lstatSync(existing, { throwIfNoEntry: false }) === undefined) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  const real = tail.length ? path.join(realExisting, ...tail) : realExisting;
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new ContainmentError(`path escapes the working directory: ${rel}`);
  }
  return real;
}

// --------------------------------------------------------------- markdown

const SCENE_BREAK_TEXT = new Set(['⁂', '***', '* * *']);
const SCENE_BREAK_RULE_RE = /^-{3,}$/;

function isSceneBreak(block) {
  return SCENE_BREAK_TEXT.has(block) || SCENE_BREAK_RULE_RE.test(block);
}

/** Split chapter markdown into blank-line-separated blocks: paragraphs or scene breaks. */
function splitBlocks(markdown) {
  const blocks = markdown
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block) => (isSceneBreak(block) ? { type: 'scene-break', text: block } : { type: 'paragraph', runs: parseInlineRuns(block) }));
}

/** Bold ("**text**") and italic ("*text*" or "_text_") runs — bold is
 *  extracted first so the italic pattern never fires on a `**` pair
 *  (mirrors parse-manuscript's ITALIC_RE). */
function parseInlineRuns(text) {
  const BOLD_RE = /\*\*(.+?)\*\*/g;
  const ITALIC_RE = /(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)|(?<!_)_(?!_)([^_\n]+?)_(?!_)/g;

  const pieces = [];
  let last = 0;
  let m;
  while ((m = BOLD_RE.exec(text)) !== null) {
    if (m.index > last) pieces.push({ text: text.slice(last, m.index), bold: false });
    pieces.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), bold: false });

  const runs = [];
  for (const piece of pieces) {
    if (piece.bold) {
      runs.push({ text: piece.text, bold: true, italic: false });
      continue;
    }
    let l2 = 0;
    let mm;
    ITALIC_RE.lastIndex = 0;
    while ((mm = ITALIC_RE.exec(piece.text)) !== null) {
      if (mm.index > l2) runs.push({ text: piece.text.slice(l2, mm.index), bold: false, italic: false });
      const inner = mm[1] ?? mm[2] ?? '';
      if (inner) runs.push({ text: inner, bold: false, italic: true });
      l2 = mm.index + mm[0].length;
    }
    if (l2 < piece.text.length) runs.push({ text: piece.text.slice(l2), bold: false, italic: false });
  }
  return runs.filter((r) => r.text);
}

// Characters XML 1.0 forbids outright (C0 controls other than tab/LF/CR, and
// U+FFFE/U+FFFF). One stray form feed or vertical tab pasted into a chapter
// would otherwise make document.xml / the XHTML unparseable, and Word or an
// e-reader refuses the whole file.
const XML_INVALID_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function xmlEscape(s) {
  return s
    .replace(XML_INVALID_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// -------------------------------------------------------------------- docx

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml"   ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>
`;
const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`;
const DOCX_DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
`;
const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">
    <w:name w:val="Normal"/>
    <w:rPr><w:rFonts w:ascii="Garamond" w:hAnsi="Garamond"/><w:sz w:val="24"/></w:rPr>
    <w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:ind w:firstLine="360"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:before="2400" w:after="600"/><w:ind w:firstLine="0"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Garamond" w:hAnsi="Garamond"/><w:sz w:val="56"/><w:b/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:pageBreakBefore/><w:spacing w:before="600" w:after="400"/><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Garamond" w:hAnsi="Garamond"/><w:sz w:val="36"/><w:b/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="Heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:spacing w:before="400" w:after="200"/><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Garamond" w:hAnsi="Garamond"/><w:sz w:val="32"/><w:b/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="SceneBreak">
    <w:name w:val="Scene Break"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr>
  </w:style>
</w:styles>
`;

function docxRun(text, { bold = false, italic = false } = {}) {
  let rpr = '';
  if (bold || italic) {
    rpr = `<w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}</w:rPr>`;
  }
  return `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function docxParaFromText(text, style = 'Normal', italic = false) {
  const runs = docxRun(text, { italic });
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs}</w:p>`;
}

function docxParaFromRuns(runs, style = 'Normal') {
  const body = runs.map((r) => docxRun(r.text, { bold: r.bold, italic: r.italic })).join('');
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${body}</w:p>`;
}

function docxPageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function buildDocxBody(book) {
  const body = [];
  body.push(docxParaFromText(book.title, 'Title'));
  body.push(docxParaFromText(`by ${book.author}`, 'Heading2'));
  body.push(docxPageBreak());

  for (const ch of book.chapters) {
    body.push(docxParaFromText(`Chapter ${ch.number}`, 'Heading1'));
    if (ch.title) body.push(docxParaFromText(ch.title, 'Heading2', true));
    for (const block of splitBlocks(ch.markdown)) {
      if (block.type === 'scene-break') {
        body.push(docxParaFromText(block.text, 'SceneBreak'));
      } else {
        body.push(docxParaFromRuns(block.runs));
      }
    }
  }
  return body.join('');
}

function buildDocx(book) {
  const bodyXml = buildDocxBody(book);
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${bodyXml}` +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    '</w:body></w:document>';

  return zip([
    { path: '[Content_Types].xml', data: DOCX_CONTENT_TYPES },
    { path: '_rels/.rels', data: DOCX_RELS },
    { path: 'word/_rels/document.xml.rels', data: DOCX_DOC_RELS },
    { path: 'word/styles.xml', data: DOCX_STYLES },
    { path: 'word/document.xml', data: documentXml },
  ]);
}

// -------------------------------------------------------------------- epub

const EPUB_CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
const EPUB_CSS = `body { font-family: Georgia, serif; line-height: 1.6; margin: 1em; }
h1   { text-align: center; margin-top: 3em; font-size: 2em; }
h2   { text-align: center; margin-top: 2em; font-size: 1.5em; }
p    { text-indent: 1.5em; margin: 0 0 0.5em; }
.scene-break { text-align: center; margin: 1.5em 0; text-indent: 0; }
.titlepage   { text-align: center; margin-top: 30%; }
.titlepage h1 { font-size: 2.5em; }
.titlepage .by { font-style: italic; margin-top: 2em; }
`;

function inlineRunsToHtml(runs) {
  return runs
    .map((r) => {
      const t = xmlEscape(r.text);
      if (r.bold) return `<strong>${t}</strong>`;
      if (r.italic) return `<em>${t}</em>`;
      return t;
    })
    .join('');
}

function htmlParagraphs(markdown) {
  return splitBlocks(markdown)
    .map((block) =>
      block.type === 'scene-break'
        ? `<p class="scene-break">${xmlEscape(block.text)}</p>`
        : `<p>${inlineRunsToHtml(block.runs)}</p>`,
    )
    .join('\n');
}

function chapterXhtml(ch, language) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${xmlEscape(language)}">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
  <title>Chapter ${ch.number}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <h1>Chapter ${ch.number}</h1>
  ${ch.title ? `<h2>${xmlEscape(ch.title)}</h2>\n` : ''}${htmlParagraphs(ch.markdown)}
</body>
</html>
`;
}

function titlepageXhtml(book, language) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${xmlEscape(language)}">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
  <title>${xmlEscape(book.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <div class="titlepage">
    <h1>${xmlEscape(book.title)}</h1>
    <p class="by">by ${xmlEscape(book.author)}</p>
  </div>
</body>
</html>
`;
}

function buildEpub(book) {
  const language = book.language || 'en';
  const year = new Date().getFullYear();
  const bookUuid = `urn:uuid:${randomUuidV4()}`;

  const manifestItems = [
    '<item id="ncx"   href="toc.ncx"         media-type="application/x-dtbncx+xml"/>',
    '<item id="css"   href="styles.css"      media-type="text/css"/>',
    '<item id="title" href="titlepage.xhtml" media-type="application/xhtml+xml"/>',
  ];
  const spineItems = ['<itemref idref="title"/>'];
  const navPoints = [];

  book.chapters.forEach((ch, i) => {
    const n = i + 1;
    const cid = `ch${String(n).padStart(3, '0')}`;
    manifestItems.push(`<item id="${cid}" href="${cid}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="${cid}"/>`);
    navPoints.push(
      `<navPoint id="np-${cid}" playOrder="${n + 1}">` +
        `<navLabel><text>Chapter ${ch.number}${ch.title ? `: ${xmlEscape(ch.title)}` : ''}</text></navLabel>` +
        `<content src="${cid}.xhtml"/></navPoint>`,
    );
  });

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookid">${bookUuid}</dc:identifier>
    <dc:title>${xmlEscape(book.title)}</dc:title>
    <dc:creator opf:role="aut">${xmlEscape(book.author)}</dc:creator>
    <dc:language>${xmlEscape(language)}</dc:language>
    <dc:date>${year}</dc:date>
  </metadata>
  <manifest>
    ${manifestItems.join('')}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join('')}
  </spine>
</package>
`;

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${bookUuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${xmlEscape(book.title)}</text></docTitle>
  <navMap>
    <navPoint id="np-title" playOrder="1"><navLabel><text>Title page</text></navLabel><content src="titlepage.xhtml"/></navPoint>
    ${navPoints.join('')}
  </navMap>
</ncx>
`;

  const entries = [
    { path: 'mimetype', data: 'application/epub+zip', store: true },
    { path: 'META-INF/container.xml', data: EPUB_CONTAINER },
    { path: 'OEBPS/content.opf', data: contentOpf },
    { path: 'OEBPS/toc.ncx', data: tocNcx },
    { path: 'OEBPS/styles.css', data: EPUB_CSS },
    { path: 'OEBPS/titlepage.xhtml', data: titlepageXhtml(book, language) },
  ];
  book.chapters.forEach((ch, i) => {
    const cid = `ch${String(i + 1).padStart(3, '0')}`;
    entries.push({ path: `OEBPS/${cid}.xhtml`, data: chapterXhtml(ch, language) });
  });

  return zip(entries);
}

function randomUuidV4() {
  // node:crypto's randomUUID is available, but this keeps the tool to a
  // single import surface consistent with the rest of the toolbox — plain
  // Math.random is fine here since the UUID only needs to be unique per
  // export, not cryptographically unpredictable.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --------------------------------------------------------------------- main

function validateInput(args) {
  if (!args || typeof args !== 'object') return 'input must be a JSON object';
  if (typeof args.title !== 'string' || !args.title) return 'title must be a non-empty string';
  if (typeof args.author !== 'string' || !args.author) return 'author must be a non-empty string';
  if (!Array.isArray(args.chapters) || !args.chapters.length) return 'chapters must be a non-empty array';
  for (const ch of args.chapters) {
    if (!ch || typeof ch.number !== 'number' || typeof ch.title !== 'string' || typeof ch.markdown !== 'string') {
      return 'each chapter needs a number, a title, and markdown';
    }
  }
  if (args.format !== 'docx' && args.format !== 'epub') return 'format must be "docx" or "epub"';
  if (typeof args.out !== 'string' || !args.out) return 'out must be a non-empty string path';
  if (args.language !== undefined && (typeof args.language !== 'string' || !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(args.language))) {
    return 'language must be a BCP 47 language tag such as "en" or "pt-BR"';
  }
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch (err) {
    process.stderr.write(`stdin was not valid JSON: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const problem = validateInput(args);
  if (problem) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
    return;
  }

  const book = {
    title: args.title,
    author: args.author,
    language: args.language,
    chapters: [...args.chapters].sort((a, b) => a.number - b.number),
  };

  let real;
  try {
    real = safeRelativePath(process.cwd(), args.out);
  } catch (err) {
    process.stderr.write(`refused: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const buf = args.format === 'docx' ? buildDocx(book) : buildEpub(book);
  // Checked before the write: an existing file at `out` is silently
  // overwritten (this tool has no separate "confirm overwrite" step), so the
  // caller needs a way to tell that happened rather than discover it later.
  const overwrote = fs.existsSync(real);
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, buf);
  process.stdout.write(JSON.stringify({ path: args.out, bytes: buf.length, overwrote }));
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
