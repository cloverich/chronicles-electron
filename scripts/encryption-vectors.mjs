// Writes spec/vectors/encryption/cases.json from spec/encryption.md, and
// export.json from spec/export-format.md ("Encrypted form"), using
// Node's crypto as the reference the Swift app (CryptoKit) is checked against.
// Usage: node scripts/encryption-vectors.mjs
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
} from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const bytes = (start, length) =>
  Buffer.from(Array.from({ length }, (_, i) => (start + i) % 256));

const hkdf = (ikm, info) =>
  Buffer.from(
    hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(info, "utf8"), 32),
  );
const hmac = (key, text) =>
  createHmac("sha256", key).update(text, "utf8").digest("hex");
const aad = (kind, id, keyId) =>
  Buffer.from(`chronicles.v1|${kind}|${id}|${keyId}`, "utf8");

function seal(key, nonce, plaintext, additional) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(additional);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, body, cipher.getAuthTag()]);
}

// Crockford base32, no padding, in groups of four.
function recoveryCode(raw) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join("-");
}

const libraryKey = bytes(0x10, 32);
const journalKey = bytes(0x40, 32);
const recovery = bytes(0x80, 20);
const journalId = "03aq5qh9copxys3mzz5l8q60f";
const generation = 1;
const domain = `${journalId}.${generation}`;

const libraryRecordKey = hkdf(libraryKey, "chronicles.v1 library");
const libraryRevisionKey = hkdf(libraryKey, "chronicles.v1 revision");
const recoveryKey = hkdf(recovery, "chronicles.v1 recovery");
const recordKey = hkdf(journalKey, "chronicles.v1 records");
const revisionKey = hkdf(journalKey, "chronicles.v1 revision");
const attachmentNameKey = hkdf(journalKey, "chronicles.v1 attachment-name");

const attachmentName =
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.png";
const attachmentFileKey = hkdf(
  journalKey,
  `chronicles.v1 attachment-file|${attachmentName}`,
);
const attachmentStreamKey = hkdf(
  journalKey,
  `chronicles.v1 attachment-stream|${attachmentName}`,
);
const attachmentRecordId = `${journalId}.${hmac(attachmentNameKey, attachmentName)}`;
const attachmentBytes = Buffer.from(
  "not really a png, but bytes all the same\n",
  "utf8",
);

const noteFile = [
  "---",
  'id: "03h0yunh0hl4mhnoj8x01gx57"',
  'title: "Weekend plans"',
  'journal: "03aq5qh9copxys3mzz5l8q60f"',
  'createdAt: "2026-10-11T13:36:00.000Z"',
  'updatedAt: "2026-10-11T13:36:00.000Z"',
  'tags: ["plans"]',
  "---",
  "",
  "Pick up the **bike** from the shop. Café at noon.",
  "",
].join("\n");
const noteRevision = createHash("sha256")
  .update(noteFile, "utf8")
  .digest("hex");
const journalPayload = `{"archivedAt":null,"id":"${journalId}","name":"Personal"}`;

const envelopes = [
  {
    name: "note under its domain's record key",
    key: hex(recordKey),
    nonce: hex(bytes(0xa0, 12)),
    aad: { kind: "note", id: "03h0yunh0hl4mhnoj8x01gx57", keyId: domain },
    plaintext: noteFile,
  },
  {
    name: "journal under its domain's record key",
    key: hex(recordKey),
    nonce: hex(bytes(0xb0, 12)),
    aad: { kind: "journal", id: journalId, keyId: domain },
    plaintext: journalPayload,
  },
  {
    name: "journal key in a library slot",
    key: hex(libraryRecordKey),
    nonce: hex(bytes(0xc0, 12)),
    aad: { kind: "key", id: domain, keyId: "library" },
    plaintextHex: hex(journalKey),
  },
  {
    name: "library key under the recovery wrapping key",
    key: hex(recoveryKey),
    nonce: hex(bytes(0xd0, 12)),
    aad: { kind: "keyring", id: "library", keyId: "recovery" },
    plaintextHex: hex(libraryKey),
  },
  {
    name: "attachment file, deterministic",
    key: hex(attachmentFileKey),
    nonce: hex(Buffer.alloc(12)),
    aad: { kind: "attachment", id: attachmentRecordId, keyId: domain },
    plaintextHex: hex(attachmentBytes),
  },
].map((item) => {
  const plain =
    item.plaintext !== undefined
      ? Buffer.from(item.plaintext, "utf8")
      : Buffer.from(item.plaintextHex, "hex");
  const sealed = seal(
    Buffer.from(item.key, "hex"),
    Buffer.from(item.nonce, "hex"),
    plain,
    aad(item.aad.kind, item.aad.id, item.aad.keyId),
  );
  return { ...item, envelope: sealed.toString("base64") };
});

// Attachment files as streams: 64 KiB chunks, each sealed with nonce = index
// (11 bytes, big-endian) ‖ 1 for the last chunk, else 0.
const chunkSize = 65536;
function sealStream(key, plaintext, additional) {
  const parts = [Buffer.from([2])];
  const count = Math.max(1, Math.ceil(plaintext.length / chunkSize));
  for (let index = 0; index < count; index++) {
    const nonce = Buffer.alloc(12);
    nonce.writeUIntBE(index, 5, 6);
    nonce[11] = index === count - 1 ? 1 : 0;
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(additional);
    const chunk = plaintext.subarray(
      index * chunkSize,
      (index + 1) * chunkSize,
    );
    parts.push(cipher.update(chunk), cipher.final(), cipher.getAuthTag());
  }
  return Buffer.concat(parts);
}
// The reference reader: chunks by size, the last one flagged; anything else throws.
function openStream(key, stream, additional) {
  if (stream[0] !== 2) throw new Error("not a stream");
  const body = stream.subarray(1);
  const segment = chunkSize + 16;
  const count = Math.max(1, Math.ceil(body.length / segment));
  const out = [];
  for (let index = 0; index < count; index++) {
    const sealed = body.subarray(index * segment, (index + 1) * segment);
    if (sealed.length < 16) throw new Error("short chunk");
    const nonce = Buffer.alloc(12);
    nonce.writeUIntBE(index, 5, 6);
    nonce[11] = index === count - 1 ? 1 : 0;
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(additional);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    out.push(
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    );
  }
  return Buffer.concat(out);
}
// Stream plaintexts are generated, not listed: byte i is i % 251.
const generated = (length) =>
  Buffer.from(Array.from({ length }, (_, i) => i % 251));
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const streamAad = {
  kind: "attachment",
  id: attachmentRecordId,
  keyId: domain,
};
const streamAdditional = aad(streamAad.kind, streamAad.id, streamAad.keyId);
const streams = [
  ["empty file", 0],
  ["shorter than a chunk", 41],
  ["exactly one chunk", chunkSize],
  ["exactly two chunks", 2 * chunkSize],
  ["two chunks and a bit", 2 * chunkSize + 100],
].map(([name, length]) => {
  const sealed = sealStream(
    attachmentStreamKey,
    generated(length),
    streamAdditional,
  );
  return {
    name,
    length,
    size: sealed.length,
    sha256: sha256(sealed),
    ...(sealed.length <= 128 ? { envelope: sealed.toString("base64") } : {}),
    sealed,
  };
});

// Each tampered stream is byte ranges of a sealed stream above, joined
// (optionally with one bit flipped), and must fail to open.
const segment = 65536 + 16;
const base = streams.find((stream) => stream.name === "two chunks and a bit");
const end = base.size;
const tamperedStreams = [
  { name: "last chunk dropped", ranges: [[0, 1 + 2 * segment]] },
  { name: "cut inside the last chunk", ranges: [[0, end - 1]] },
  {
    name: "chunks swapped",
    ranges: [
      [0, 1],
      [1 + segment, 1 + 2 * segment],
      [1, 1 + segment],
      [1 + 2 * segment, end],
    ],
  },
  {
    name: "a chunk repeated",
    ranges: [
      [0, 1 + segment],
      [1, end],
    ],
  },
  {
    name: "bytes after the last chunk",
    ranges: [
      [0, end],
      [end - 17, end],
    ],
  },
  { name: "only the version byte", ranges: [[0, 1]] },
  {
    name: "flipped bit in the second chunk",
    ranges: [[0, end]],
    flip: 1 + segment + 10,
  },
].map((item) => {
  const bytes = Buffer.concat(
    item.ranges.map(([from, to]) => base.sealed.subarray(from, to)),
  );
  if (item.flip !== undefined) bytes[item.flip] ^= 0x01;
  return { from: base.name, ...item, sha256: sha256(bytes) };
});
// Another record's AAD, and the earlier single-envelope key, refuse it too.
tamperedStreams.push(
  {
    name: "moved to another attachment record",
    from: base.name,
    ranges: [[0, end]],
    aad: { ...streamAad, id: `${journalId}.${"0".repeat(64)}` },
  },
  {
    name: "opened with the 0x01 file key",
    from: base.name,
    ranges: [[0, end]],
    key: hex(attachmentFileKey),
  },
);

for (const stream of streams) {
  const opened = openStream(
    attachmentStreamKey,
    stream.sealed,
    streamAdditional,
  );
  if (!opened.equals(generated(stream.length)))
    throw new Error(`${stream.name} doesn't round-trip`);
}
for (const item of tamperedStreams) {
  let bytes = Buffer.concat(
    item.ranges.map(([from, to]) => base.sealed.subarray(from, to)),
  );
  if (item.flip !== undefined) bytes[item.flip] ^= 0x01;
  const key = item.key ? Buffer.from(item.key, "hex") : attachmentStreamKey;
  const at = item.aad ?? streamAad;
  let opened = true;
  try {
    openStream(key, bytes, aad(at.kind, at.id, at.keyId));
  } catch {
    opened = false;
  }
  if (opened) throw new Error(`${item.name} opened`);
}

// The key record holding the library slot above; its revision is the payload's sha256.
const keyRecordPayload = JSON.stringify({
  generation,
  slots: [{ key: envelopes[2].envelope, type: "library" }],
});
const keyRecordRevision = createHash("sha256")
  .update(keyRecordPayload, "utf8")
  .digest("hex");

// Each tampered case must fail to open: a flipped ciphertext bit, a moved record, a wrong key id.
const note = envelopes[0];
const flipped = Buffer.from(note.envelope, "base64");
flipped[20] ^= 0x01;
const tampered = [
  {
    name: "flipped ciphertext bit",
    key: note.key,
    aad: note.aad,
    envelope: flipped.toString("base64"),
  },
  {
    name: "moved to another note",
    key: note.key,
    aad: { ...note.aad, id: "03h0yunh0hl4mhnoj8x01gx58" },
    envelope: note.envelope,
  },
  {
    name: "claims another journal",
    key: note.key,
    aad: { ...note.aad, keyId: "03aqdjryx3t7dd9h7lezzx83o.1" },
    envelope: note.envelope,
  },
  {
    name: "claims another generation",
    key: note.key,
    aad: { ...note.aad, keyId: `${journalId}.2` },
    envelope: note.envelope,
  },
  {
    name: "unknown version",
    key: note.key,
    aad: note.aad,
    envelope: Buffer.concat([
      Buffer.from([2]),
      Buffer.from(note.envelope, "base64").subarray(1),
    ]).toString("base64"),
  },
];

const cases = {
  keys: {
    libraryKey: hex(libraryKey),
    recoveryBytes: hex(recovery),
    recoveryCode: recoveryCode(recovery),
    fingerprint: createHash("sha256")
      .update(libraryKey)
      .digest("hex")
      .slice(0, 16),
    libraryRecordKey: hex(libraryRecordKey),
    libraryRevisionKey: hex(libraryRevisionKey),
    recoveryKey: hex(recoveryKey),
  },
  journal: {
    id: journalId,
    generation,
    keyId: domain,
    journalKey: hex(journalKey),
    recordKey: hex(recordKey),
    revisionKey: hex(revisionKey),
    attachmentNameKey: hex(attachmentNameKey),
  },
  revision: { revision: noteRevision, hmac: hmac(revisionKey, noteRevision) },
  attachment: {
    name: attachmentName,
    recordId: attachmentRecordId,
    fileKey: hex(attachmentFileKey),
    streamKey: hex(attachmentStreamKey),
  },
  keyRecord: {
    payload: keyRecordPayload,
    revision: keyRecordRevision,
    hmac: hmac(libraryRevisionKey, keyRecordRevision),
  },
  envelopes,
  tampered,
  streams: {
    chunkSize,
    plaintext: "byte i is i % 251",
    key: hex(attachmentStreamKey),
    aad: streamAad,
    cases: streams.map(({ sealed, ...rest }) => rest),
    tampered: tamperedStreams,
  },
};

// Encrypted exports (spec/export-format.md, "Encrypted form"): magic, a
// one-line header with the export key in a library slot beside the keyring,
// then the zip as a 0x02 stream bound to the header's hash.
const magic = "chronicles-encrypted-export/1\n";
const libraryExportKey = hkdf(libraryKey, "chronicles.v1 export");
const keyringEnvelope = envelopes[3].envelope;
const fingerprint = createHash("sha256")
  .update(libraryKey)
  .digest("hex")
  .slice(0, 16);
function sealExport({ exportKey, exportId, slotNonce, plaintext, edit }) {
  const slot = seal(
    libraryExportKey,
    slotNonce,
    exportKey,
    aad("export", exportId, "library"),
  ).toString("base64");
  let header = {
    exportId,
    formatVersion: "2.0",
    slots: [
      { fingerprint, key: slot, keyring: keyringEnvelope, type: "library" },
    ],
  };
  if (edit) header = edit(header);
  const headerText = JSON.stringify(header);
  const streamKey = hkdf(exportKey, "chronicles.v1 export-stream");
  const additional = Buffer.from(
    `chronicles.v1|export-stream|${exportId}|${sha256(Buffer.from(headerText, "utf8"))}`,
    "utf8",
  );
  const file = Buffer.concat([
    Buffer.from(magic + headerText + "\n", "utf8"),
    sealStream(streamKey, plaintext, additional),
  ]);
  return { header: headerText, streamKey, file };
}
// The reference reader: `with` is the library key or a recovery code's bytes.
function openExport(file, { key, recovery }) {
  const firstLine = file.indexOf(0x0a);
  if (file.subarray(0, firstLine + 1).toString("utf8") !== magic)
    throw new Error("magic");
  const headerEnd = file.indexOf(0x0a, firstLine + 1);
  const headerText = file.subarray(firstLine + 1, headerEnd).toString("utf8");
  const header = JSON.parse(headerText);
  if (header.formatVersion.split(".")[0] !== "2") throw new Error("header");
  let exportKey;
  for (const slot of header.slots) {
    if (slot.type !== "library") continue;
    let lk = key;
    if (recovery) {
      try {
        lk = openEnvelope(
          hkdf(recovery, "chronicles.v1 recovery"),
          slot.keyring,
          aad("keyring", "library", "recovery"),
        );
      } catch {
        continue;
      }
    }
    const print = createHash("sha256").update(lk).digest("hex").slice(0, 16);
    if (print !== slot.fingerprint) continue;
    try {
      exportKey = openEnvelope(
        hkdf(lk, "chronicles.v1 export"),
        slot.key,
        aad("export", header.exportId, "library"),
      );
    } catch {
      continue;
    }
  }
  if (!exportKey) throw new Error("slot");
  const additional = Buffer.from(
    `chronicles.v1|export-stream|${header.exportId}|${sha256(Buffer.from(headerText, "utf8"))}`,
    "utf8",
  );
  try {
    return openStream(
      hkdf(exportKey, "chronicles.v1 export-stream"),
      file.subarray(headerEnd + 1),
      additional,
    );
  } catch {
    throw new Error("stream");
  }
}
function openEnvelope(key, base64, additional) {
  const envelope = Buffer.from(base64, "base64");
  if (envelope[0] !== 1) throw new Error("not a v1 envelope");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    envelope.subarray(1, 13),
  );
  decipher.setAAD(additional);
  decipher.setAuthTag(envelope.subarray(envelope.length - 16));
  return Buffer.concat([
    decipher.update(envelope.subarray(13, envelope.length - 16)),
    decipher.final(),
  ]);
}

const exportInputs = [
  ["empty zip bytes", 0, 0x00],
  ["shorter than a chunk", 41, 0x20],
  ["two chunks and a bit", 2 * chunkSize + 100, 0x40],
].map(([name, length, seed]) => ({
  name,
  length,
  exportKey: bytes(0x60 + seed, 32),
  exportId: hex(bytes(0x90 + seed, 16)),
  slotNonce: bytes(0xe0 + seed, 12),
}));
const exportCases = exportInputs.map((input) => {
  const sealed = sealExport({ ...input, plaintext: generated(input.length) });
  for (const opener of [{ key: libraryKey }, { recovery }]) {
    if (!openExport(sealed.file, opener).equals(generated(input.length)))
      throw new Error(`${input.name} doesn't round-trip`);
  }
  return {
    name: input.name,
    length: input.length,
    exportKey: hex(input.exportKey),
    exportId: input.exportId,
    slotNonce: hex(input.slotNonce),
    header: sealed.header,
    streamKey: hex(sealed.streamKey),
    size: sealed.file.length,
    sha256: sha256(sealed.file),
    ...(sealed.file.length <= 4096
      ? { file: sealed.file.toString("base64") }
      : {}),
    sealed,
  };
});

// Each tampered export is a whole file, derived from "shorter than a chunk",
// that must fail at the step `fails` names when opened `with` a key.
const short = exportCases.find((item) => item.name === "shorter than a chunk");
const shortInput = exportInputs.find((item) => item.name === short.name);
const other = exportInputs.find((item) => item.name === "empty zip bytes");
const shortFile = short.sealed.file;
const headerStart = magic.length;
const streamStart = headerStart + Buffer.byteLength(short.header) + 1;
const withHeader = (edit) =>
  sealExport({ ...shortInput, plaintext: generated(41), edit }).file;
const reheader = (headerText) =>
  Buffer.concat([
    Buffer.from(magic + headerText + "\n", "utf8"),
    shortFile.subarray(streamStart),
  ]);
const otherSlot = JSON.parse(
  sealExport({ ...other, plaintext: Buffer.alloc(0) }).header,
).slots[0];
const otherRecovery = bytes(0x81, 20);
const tamperedExports = [
  {
    name: "header edited after sealing",
    file: reheader(short.header.replace('"2.0"', '"2.1"')),
    with: "libraryKey",
    fails: "stream",
  },
  {
    name: "slot from another export",
    file: reheader(
      JSON.stringify({ ...JSON.parse(short.header), slots: [otherSlot] }),
    ),
    with: "libraryKey",
    fails: "slot",
  },
  {
    name: "export id changed",
    file: reheader(
      JSON.stringify({ ...JSON.parse(short.header), exportId: "0".repeat(32) }),
    ),
    with: "libraryKey",
    fails: "slot",
  },
  {
    name: "wrong recovery code",
    file: shortFile,
    with: { recoveryCode: recoveryCode(otherRecovery) },
    fails: "slot",
  },
  {
    name: "another library's key",
    file: shortFile,
    with: { libraryKey: hex(bytes(0x11, 32)) },
    fails: "slot",
  },
  {
    name: "only a slot type it doesn't know",
    file: withHeader((header) => ({
      ...header,
      slots: header.slots.map((slot) => ({ ...slot, type: "passphrase" })),
    })),
    with: "libraryKey",
    fails: "slot",
  },
  {
    name: "unknown major format version",
    file: withHeader((header) => ({ ...header, formatVersion: "3.0" })),
    with: "libraryKey",
    fails: "header",
  },
  {
    name: "a later magic version",
    file: Buffer.concat([
      Buffer.from("chronicles-encrypted-export/2\n", "utf8"),
      shortFile.subarray(headerStart),
    ]),
    with: "libraryKey",
    fails: "magic",
  },
  {
    name: "stream from another export",
    file: Buffer.concat([
      shortFile.subarray(0, streamStart),
      exportCases[0].sealed.file.subarray(
        headerStart + Buffer.byteLength(exportCases[0].header) + 1,
      ),
    ]),
    with: "libraryKey",
    fails: "stream",
  },
  {
    name: "stream cut inside its last chunk",
    file: shortFile.subarray(0, shortFile.length - 1),
    with: "recoveryCode",
    fails: "stream",
  },
  {
    name: "bytes after the last chunk",
    file: Buffer.concat([shortFile, shortFile.subarray(-17)]),
    with: "libraryKey",
    fails: "stream",
  },
  {
    name: "flipped bit in the stream",
    file: (() => {
      const copy = Buffer.from(shortFile);
      copy[streamStart + 5] ^= 0x01;
      return copy;
    })(),
    with: "libraryKey",
    fails: "stream",
  },
].map((item) => {
  const opener =
    item.with === "libraryKey"
      ? { key: libraryKey }
      : item.with === "recoveryCode"
        ? { recovery }
        : item.with.libraryKey
          ? { key: Buffer.from(item.with.libraryKey, "hex") }
          : { recovery: otherRecovery };
  let failed = "opened";
  try {
    openExport(item.file, opener);
  } catch (error) {
    failed = error.message;
  }
  if (failed !== item.fails)
    throw new Error(`${item.name}: expected ${item.fails}, got ${failed}`);
  return { ...item, file: item.file.toString("base64") };
});

mkdirSync("spec/vectors/encryption", { recursive: true });
writeFileSync(
  "spec/vectors/encryption/export.json",
  JSON.stringify(
    {
      magic,
      libraryKey: hex(libraryKey),
      recoveryCode: recoveryCode(recovery),
      libraryExportKey: hex(libraryExportKey),
      plaintext: "byte i is i % 251",
      cases: exportCases.map(({ sealed, ...rest }) => rest),
      tampered: tamperedExports,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  "spec/vectors/encryption/cases.json",
  JSON.stringify(cases, null, 2) + "\n",
);
console.log(
  `spec/vectors/encryption/export.json: ${exportCases.length} exports, ${tamperedExports.length} tampered`,
);
console.log(
  `spec/vectors/encryption/cases.json: ${envelopes.length} envelopes, ${tampered.length} tampered, ${streams.length} streams, ${tamperedStreams.length} tampered streams`,
);
