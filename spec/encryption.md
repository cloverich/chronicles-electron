# Encryption

How a library's synced records are encrypted end to end, so the server
(CloudKit today, a relay later) stores only ciphertext. Status: draft, E1
implemented by the Swift app. Builds on [sync.md](sync.md).

## Threats

| Threat                                                     | Covered by                             |
| ---------------------------------------------------------- | -------------------------------------- |
| The server, or whoever reads it, reads notes               | This document (phase E1)               |
| A relay or another app syncs the library without keys      | This document: records replicate blind |
| A delegate (a person, an LLM) reads journals not shared    | Key domains (below), grants (later)    |
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

Readable: record kinds and IDs (random), the key domain a record is encrypted
under, sizes, change times, whether a record is a tombstone, and each key
record's slot types. So the server learns the shape of activity (something in
journal X changed at time T), never titles, text, tags, journal names, or
attachment bytes. Attachment names are keyed hashes, so the server can't
confirm a known file, nor tell that two journals hold the same one.

## Key domains

Each journal is a **key domain**: its journal record, its notes, and the
attachments its notes use are encrypted under keys derived from the
journal's key, and nothing else is. Whoever holds a journal's key can read
and write exactly that journal. The library key only wraps journal keys.

This is what later lets a journal be locked, or shared with one person or
one delegate, with a cryptographic guarantee rather than a promise: access
is a key, handed out per journal ([Journal access](#journal-access-later)).

## Keys

- **Library key (LK):** 32 random bytes, made once per library. Every device
  holds it, in the iCloud Keychain as a synchronizable item (service
  `dev.pinecoder.chronicles.library-key`, account the library's
  `fingerprint`). A device without it can't read the library.
- **Journal key (JK):** 32 random bytes per journal and **generation**
  (an integer from 1; a new generation replaces the key, see rotation). It
  lives on the server in the journal's key record, wrapped in one or more
  slots; in E1 the only slot is wrapped under LK.
- **Recovery code:** 20 random bytes, shown once when encryption is turned on,
  written as 32 Crockford base32 characters in groups of four
  (`XXXX-XXXX-…`; case and hyphens ignored on entry). It wraps LK on the
  server, so a device that lost the keychain can still join. Losing both the
  keychain and the code loses the library's synced copy (local copies are
  unaffected).

A domain's **key id** is `<journal ID>.<generation>` (journal IDs are
`[0-9a-z]`, so the dot is unambiguous). The library's key id is `library`.

Derived keys use HKDF-SHA256 with an empty salt and these `info` strings. A
key is used only through its derived keys, never directly:

| Key                   | IKM           | info                                      |
| --------------------- | ------------- | ----------------------------------------- |
| Library record key    | LK            | `chronicles.v1 library`                   |
| Library revision key  | LK            | `chronicles.v1 revision`                  |
| Record key            | JK            | `chronicles.v1 records`                   |
| Revision key          | JK            | `chronicles.v1 revision`                  |
| Attachment name key   | JK            | `chronicles.v1 attachment-name`           |
| Attachment file key   | JK            | `chronicles.v1 attachment-file \|` + name |
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
another record, journal, or generation fails to open:

```
AAD = "chronicles.v1|" ‖ kind ‖ "|" ‖ record id ‖ "|" ‖ key id
```

`key id` is a domain's key id, `library`, or `recovery`. In a text field the
envelope is standard base64 with padding.

## Records

Encryption changes each sync record's payload and its `revision` field, and
adds a plaintext `keyId` field naming the domain (or `library`).

| Kind         | Record id             | Payload when encrypted                                          | Key id   |
| ------------ | --------------------- | --------------------------------------------------------------- | -------- |
| `journal`    | journal ID            | envelope of the journal payload, under the domain record key    | domain   |
| `note`       | note ID               | envelope of the note file, under the domain record key          | domain   |
| `attachment` | `<journal ID>.<hmac>` | the file envelope (below)                                       | domain   |
| `key`        | journal ID            | the key record (below), plaintext JSON                          | library  |
| `keyring`    | `library`             | fingerprint, and envelope of LK under the recovery wrapping key | recovery |

- **Revisions** on the server are `HMAC-SHA256(revision key, revision)` in
  lowercase hex, with the domain's revision key (the library revision key for
  `key` records, whose revision is the sha256 of their payload): equal
  plaintexts compare equal, but a known text can't be confirmed. Change
  detection is unchanged: devices compare their own plaintext revisions with
  their sync state.
- **Moving a note** re-encrypts it under the new journal's domain, and its
  attachments are sent in that domain if they aren't there yet.
- **Attachments** belong to a domain: one record per journal whose notes use
  the file, named `<journal ID>.<hmac>` with `<hmac>` =
  `HMAC-SHA256(domain attachment name key, name)` in lowercase hex. A file used
  in two journals is stored twice; that is the price of unlinkable domains. An
  attachment no note uses isn't sent. Each file is encrypted under its own file
  key with an all-zero nonce, which is safe because each key encrypts exactly
  one plaintext, and makes the upload deterministic within a domain. The
  record's text field holds the `name` as an envelope under the domain record
  key (same AAD as the file); a reader checks it against the record id and the
  bytes' hash.
- **Key records** (`key.<journal ID>`) are compact JSON:
  `{"generation":1,"slots":[{"key":"<envelope>","type":"library"}]}`. A
  `library` slot's envelope is JK under the library record key, with AAD kind
  `key`, record id the domain's key id, key id `library`. Readers ignore slot
  types they don't know. No record of a domain is sent until the server has
  accepted its key record; when two devices make a key for the same journal,
  the one the server accepted first wins, and the other adopts it.
- **`keyring.library`** is compact JSON `{"fingerprint":"…","key":"<envelope>"}`:
  LK under the recovery wrapping key, AAD kind `keyring`, id `library`, key id
  `recovery`. Devices holding the same LK adopt whichever keyring the server has.
- **Opening** a domain record checks that it belongs to the domain: a note's
  `journal` (a journal record's `id`) must be the domain's journal. A record
  that fails to open is skipped, never applied. One whose key hasn't arrived
  waits until it does.

## Turning it on, and joining

- **Turning on** replaces the server's copy: the zone is deleted and recreated,
  then every record is sent encrypted. Every other device sees the zone go,
  stops syncing (sync.md), and rejoins once it has LK. Deleting the zone, rather
  than overwriting records, leaves no plaintext versions behind.
- **Joining:** a device that finds a `keyring` whose fingerprint matches a key
  in its keychain uses it; otherwise it asks for the recovery code, and applies
  and sends nothing until it has it. A device never sends plaintext records to
  a zone that has a keyring: a joining device sends nothing until its first
  fetch has finished, and one that learns mid-fetch that the library is
  encrypted forgets what it applied and fetches again with the key.
- **Turning off** is the same as turning on, in reverse, and needs LK.

## Journal access (later)

None of this is built in E1; the formats above are shaped so it needs no
migration, only new slot types and a new generation of the affected journals.

- **Grants.** A delegate (a person's device, Engram, an LLM's agent) has its own
  key pair and never holds LK. Granting it a journal adds a `recipient` slot
  to that journal's key record: JK wrapped to the delegate's public key
  (X25519 key agreement, then HKDF to a wrapping key). It can then read and
  write that journal's records, and has no key for any other: not their
  notes, names, or attachments. Delegates reach records through a relay;
  CloudKit's private database is the person's devices only.
- **Revoking** rotates the journal: a new generation and JK, every record of
  the domain re-encrypted and re-sent, and slots only for those who keep
  access. Re-saving replaces each record, so no ciphertext under the old key
  stays on the server. A revoked delegate keeps whatever it already read.
- **Locks (E2).** A journal can take its own unlock secret (a `passphrase`
  slot: PBKDF2-HMAC-SHA256, at least 600,000 iterations, salt and count in
  the slot) in place of its `library` slot. Until unlocked on a device, its
  notes stay ciphertext there too: absent from lists and search, derived data
  purged on lock, and its activity rows ([activity.md](activity.md)) sealed
  under its key. This needs encrypted local storage.
- **On the device.** In E1 the local library is plaintext, so a delegate on
  the same device (an MCP server, a CLI) is scoped by the app that serves it,
  and the OS keeps other processes out of the app's container: a policy, not
  a cryptographic guarantee. A hard guarantee there needs E2: the journal
  stays ciphertext locally unless unlocked.

## Vectors

`vectors/encryption/cases.json`: fixed keys and nonces in, exact outputs out.
An implementation passes when it derives every key, fingerprint, HMAC, and
envelope byte for byte, opens each envelope to its plaintext, and refuses each
`tampered` case.
