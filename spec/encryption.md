# Encryption

How a library's synced records are encrypted end to end, so the server
(CloudKit today, a relay later) stores only ciphertext. Status: draft, not yet
implemented. Builds on [sync.md](sync.md).

## Threats

| Threat                                                     | Covered by                             |
| ---------------------------------------------------------- | -------------------------------------- |
| The server, or whoever reads it, reads notes               | This document (phase E1)               |
| A relay or another app syncs the library without keys      | This document: records replicate blind |
| Someone holding an unlocked device reads a private journal | Journal locks (phase E2, below)        |
| A stolen, locked device                                    | The OS: iOS Data Protection, FileVault |

CloudKit already end-to-end encrypts the `text` field (an encrypted field), but
not assets (attachments, large notes) unless the account has Advanced Data
Protection, and not record metadata. A relay would see everything. Encrypting
in the app makes the server's view the same everywhere.

**Not covered:** the device itself while unlocked. The local library stays
plaintext in phase E1, protected by the OS; exports and backups stay plaintext,
since they are the person's own copies.

## What the server can see

Readable: record kinds and IDs (random), the journal ID a note is encrypted
under, sizes, change times, and whether a record is a tombstone. So the
server learns the shape of activity (something in journal X changed at time T),
never titles, text, tags, journal names, or attachment bytes. Attachment names
are keyed hashes, so the server can't confirm a known file.

## Keys

- **Library key (LK):** 32 random bytes, made once per library. Every device
  holds it, in the iCloud Keychain as a synchronizable item (service
  `dev.pinecoder.chronicles.library-key`, account the library's
  `fingerprint`). A device without it can't read the library.
- **Journal key (JK):** 32 random bytes per journal, stored on the server
  wrapped under LK (a `key` record). Notes are encrypted under their journal's
  key, so a journal can later be locked or shared on its own (E2).
- **Recovery code:** 20 random bytes, shown once when encryption is turned on,
  written as 32 Crockford base32 characters in groups of four
  (`XXXX-XXXX-…`; case and hyphens ignored on entry). It wraps LK on the
  server, so a device that lost the keychain can still join. Losing both the
  keychain and the code loses the library's synced copy (local copies are
  unaffected).

Derived keys use HKDF-SHA256 with an empty salt and these `info` strings:

| Key                   | IKM           | info                                      |
| --------------------- | ------------- | ----------------------------------------- |
| Library record key    | LK            | `chronicles.v1 library`                   |
| Revision key          | LK            | `chronicles.v1 revision`                  |
| Attachment name key   | LK            | `chronicles.v1 attachment-name`           |
| Attachment file key   | LK            | `chronicles.v1 attachment-file \|` + name |
| Recovery wrapping key | recovery code | `chronicles.v1 recovery`                  |

`name` is the attachment's `<sha256><ext>`. The **fingerprint** is the first
8 bytes of SHA-256 of LK, in lowercase hex: it names the key without revealing it.

## Envelope

Every encrypted value is AES-256-GCM:

```
envelope = 0x01 ‖ nonce (12 bytes) ‖ ciphertext ‖ tag (16 bytes)
```

The nonce is random, except for attachment files (below). The additional
authenticated data binds the envelope to its place, so a ciphertext moved to
another record fails to open:

```
AAD = "chronicles.v1|" ‖ kind ‖ "|" ‖ record id ‖ "|" ‖ key id
```

`key id` is `library`, `recovery`, or a journal ID. In a text field the
envelope is standard base64 with padding.

## Records

Encryption changes each sync record's payload and its `revision` field.
Record names and kinds are unchanged except attachments.

| Kind         | Payload when encrypted                                          | Key id     |
| ------------ | --------------------------------------------------------------- | ---------- |
| `journal`    | envelope of the journal payload, under the library record key   | `library`  |
| `note`       | envelope of the note file, under the journal's JK               | journal ID |
| `attachment` | the file envelope (below)                                       | `library`  |
| `key`        | envelope of JK under the library record key                     | `library`  |
| `keyring`    | fingerprint, and envelope of LK under the recovery wrapping key | `recovery` |

- **Notes** carry their key id in a plaintext `keyId` field, so a reader knows
  which JK opens them. Moving a note re-encrypts it under the new journal's key.
- **Revisions** on the server are `HMAC-SHA256(revision key, revision)` in
  lowercase hex: equal plaintexts compare equal, but a known text can't be
  confirmed. Change detection is unchanged: devices compare their own
  plaintext revisions with their sync state.
- **Attachments** are named `attachment.<hmac>`, where `<hmac>` is
  `HMAC-SHA256(attachment name key, name)` in lowercase hex. Each file is
  encrypted under its own file key with an all-zero nonce, which is safe
  because each key encrypts exactly one plaintext, and makes the upload
  deterministic: the same file is stored once. The original `name` travels
  inside the note text, as today.
- **`key.<journal id>`** holds a journal's JK. **`keyring.library`** holds the
  fingerprint and the recovery-wrapped LK. Both are saved before any record
  that needs them.

## Turning it on, and joining

- **Turning on** replaces the server's copy: the zone is deleted and recreated,
  then every record is sent encrypted. Every other device sees the zone go,
  stops syncing (sync.md), and rejoins once it has LK. Deleting the zone, rather
  than overwriting records, leaves no plaintext versions behind.
- **Joining:** a device that finds a `keyring` whose fingerprint matches a key
  in its keychain uses it; otherwise it asks for the recovery code. A device
  never sends plaintext records to a zone that has a keyring.
- **Turning off** is the same as turning on, in reverse, and needs LK.

## Journal locks (E2, later)

A journal can take its own unlock secret (a passphrase, PBKDF2-HMAC-SHA256
with at least 600,000 iterations, parameters stored with the slot) in place of
being wrapped under LK. Until unlocked on a device, its notes stay ciphertext
there too: absent from lists and search, derived data purged on lock, and
its activity rows ([activity.md](activity.md)) sealed under its key. This
needs encrypted local storage and is deferred until E1 is in use.

## Vectors

`vectors/encryption/cases.json`: fixed keys and nonces in, exact outputs out.
An implementation passes when it derives every key, fingerprint, HMAC, and
envelope byte for byte, opens each envelope to its plaintext, and refuses each
`tampered` case.
