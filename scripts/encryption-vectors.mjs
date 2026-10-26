// Writes spec/vectors/encryption/cases.json from spec/encryption.md, using
// Node's crypto as the reference the Swift app (CryptoKit) is checked against.
// Usage: node scripts/encryption-vectors.mjs
import { createCipheriv, createHash, createHmac, hkdfSync } from "node:crypto";
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
  },
  keyRecord: {
    payload: keyRecordPayload,
    revision: keyRecordRevision,
    hmac: hmac(libraryRevisionKey, keyRecordRevision),
  },
  envelopes,
  tampered,
};

mkdirSync("spec/vectors/encryption", { recursive: true });
writeFileSync(
  "spec/vectors/encryption/cases.json",
  JSON.stringify(cases, null, 2) + "\n",
);
console.log(
  `spec/vectors/encryption/cases.json: ${envelopes.length} envelopes, ${tampered.length} tampered`,
);
