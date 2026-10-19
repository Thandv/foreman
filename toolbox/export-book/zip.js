// Ported from the author's earlier tools (a tested, zero-dependency
// ZIP writer/reader for the same job — EPUB and DOCX are both ZIP containers).
// Only the TypeScript types were dropped; the format logic is unchanged.
//
// A minimal ZIP writer.
//
// EPUB and .docx are both ZIP containers. Writing one by hand is ~150 lines
// of well-specified format, against a third-party archiver that would have
// to be vetted for a zero-dependency, offline toolbox tool. Two things this
// must get exactly right, because e-readers and Word are unforgiving:
//   - EPUB requires `mimetype` FIRST and STORED (uncompressed), or the file
//     is not recognised as an EPUB at all.
//   - Every entry needs a correct CRC-32 and both sizes in the local header;
//     data descriptors are legal but many readers do not implement them.

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// DOS date/time. Fixed rather than "now": a byte-identical input should give
// a byte-identical file, which is what makes an export diffable and testable.
const DOS_TIME = 0;
const DOS_DATE = 0x2821; // 2000-01-01

/**
 * @param {Array<{ path: string, data: Buffer | string, store?: boolean }>} entries
 * @returns {Buffer}
 */
export function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const stored = !!entry.store;
    const body = stored ? raw : deflateRawSync(raw);
    const sum = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    // Bit 11 marks the name as UTF-8. Without it a non-ASCII entry name is
    // CP437 per APPNOTE 4.4.4, and e.g. `chapitre-café.xhtml` arrives mojibaked.
    const flags = nameBuf.length === entry.path.length ? 0 : 0x800;
    local.writeUInt16LE(flags, 6); // no data descriptor, so the sizes are here
    local.writeUInt16LE(stored ? 0 : 8, 8); // 0 = store, 8 = deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL_SIG, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/**
 * Read a ZIP back into its entries. Used by this tool's own tests to verify
 * a written .docx/.epub unzips correctly, without trusting the write path to
 * grade its own homework.
 *
 * Bounded: a container this tool produces is small, and one handed to a test
 * as a fixture may not be, so decompression is capped.
 *
 * @param {Buffer} buf
 * @param {number} [maxBytes]
 * @returns {Map<string, Buffer>}
 */
export function unzipAll(buf, maxBytes = 50_000_000) {
  const out = new Map();
  // Find the end-of-central-directory record, scanning back over its comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70_000; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== CENTRAL_SIG) break;
    if (total >= maxBytes) break;
    const method = buf.readUInt16LE(off + 10);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (localOff + 30 > buf.length) {
      off += 46 + nameLen + extraLen + commentLen;
      continue;
    }
    try {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const compSize = Math.min(buf.readUInt32LE(off + 20), Math.max(0, buf.length - start));
      const raw = buf.subarray(start, start + compSize);
      const data = method === 0
        ? Buffer.from(raw.subarray(0, maxBytes - total))
        : inflateRawSync(raw, { maxOutputLength: maxBytes - total });
      total += data.length;
      out.set(name, data);
    } catch {
      /* an unreadable member is not a reason to lose the readable ones */
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
