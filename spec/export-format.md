# Export format

Format version **2.0**. The export is the archive format, the bootstrap path
between apps, and the definition of a note's canonical bytes (and therefore its
revision).

An export is a tree of files. It travels either as a folder or as a single zip
file holding the same tree (see [Single-file form](#single-file-form)), which
may be sealed with the library's key (see [Encrypted form](#encrypted-form)). It
covers either the whole library or chosen journals (see
[Partial export](#partial-export)).

## Layout

```
<export>/
  manifest.json          canonical; byte-stable for unchanged data
  export-info.json       non-canonical: {"exportedAt": "<timestamp>"}
  <journal-dir>/<id>.md  one file per note
  _attachments/<aa>/<sha256><ext>
                         attachments referenced by exported notes (aa = sha256[0:2])
```

Two exports of unchanged data are byte-identical except `export-info.json`
(for the single-file form: their extracted trees are).
Writers publish atomically (write to a temp sibling, then rename) and refuse an
existing destination.

## Journal directories

Each journal maps to a unique directory name. Assign in code-point order of
journal name:

1. Replace each of `< > : " / \ | ? *`, U+0000–U+001F, and U+007F with `_`.
2. Strip trailing `.` and space characters.
3. If empty, use `journal`.
4. If it starts with `.`, `_`, `*`, or `~`, prefix `j`.
5. If it is a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
   `LPT1`–`LPT9`, any case), append `_`.
6. If the result equals (ignoring ASCII case) `_attachments` or an
   already-assigned directory, append `-2`, `-3`, … until unique.

The manifest records the mapping; readers use it rather than recomputing.

## Note file

UTF-8 without BOM, LF line endings.

```
---
<frontmatter lines>
---
                                  ← blank line, only if the body is non-empty
<body>
```

### Frontmatter lines

One line per key, `<key>: <value>`. Every value is the compact JSON encoding
(as ECMAScript `JSON.stringify`, no whitespace) of the field — valid YAML flow
syntax, so ordinary YAML readers parse it.

Order:

1. `id`
2. `title` — omitted when absent; present (possibly `""`) otherwise
3. `journal` — journal ID (not the name, so a journal rename does not change
   the revision of every note in it)
4. `createdAt`
5. `updatedAt`
6. `tags` — deduplicated, sorted by code point; `[]` when empty
7. user keys, sorted by code point; keys with `undefined` values omitted

User keys are written bare when they match `^[A-Za-z][A-Za-z0-9_-]*$` and are
not (case-insensitively) `null`, `true`, `false`, `yes`, `no`, `on`, `off`,
`y`, `n`; otherwise as a JSON string. Object values have their keys sorted by
code point, recursively. Array order is preserved.

JSON string encoding: escape `"` and `\`; `\b \f \n \r \t` for those
characters; other U+0000–U+001F as `\u00xx` (lowercase hex); everything else,
including `/` and non-ASCII, literally. Numbers use the shortest round-trip
form (`3`, `0.5`, `1e+21`).

### Body

The note's `content` with CRLF converted to LF and trailing newlines removed,
followed by exactly one LF. An empty body writes nothing after the closing
fence. Leading blank lines are preserved.

### Links

Writers rewrite note links to `../<journal-dir>/<id>.md`, using the target
note's current journal (stale or legacy journal segments are corrected). The
directory segment is percent-encoded only for U+0000–U+0020, `%`, `(`, `)`,
`<`, `>`, `#`, `?`, `\`, U+007F; other characters are written literally. Links
to notes not in the export, links inside code, and remote URLs are untouched.
Only the destination bytes change; the rest of the body is preserved.

Writers rewrite `chronicles://attachment/<sha256><ext>` to
`../_attachments/<aa>/<sha256><ext>` when the blob exists; a missing blob's
reference is left in stored form and reported.

Readers map both back to stored forms (see
[data-model.md](data-model.md#reference-grammar)).

## Revision

Each manifest note carries the note's `revision` (see
[data-model.md](data-model.md#revision)): the hash of its canonical
serialization with stored-form references. For a note without note links or
attachments this equals the sha256 of the exported file.

## Manifest

`manifest.json` is `JSON.stringify(manifest, null, 2)` plus a trailing LF, with
keys in exactly this order:

```json
{
  "formatVersion": "2.0",
  "journals": [
    { "id": "<uuid25>", "name": "work", "dir": "work", "archivedAt": null }
  ],
  "notes": [
    {
      "id": "…",
      "journalId": "<uuid25>",
      "path": "work/<id>.md",
      "revision": "<sha256>"
    }
  ],
  "attachments": [
    {
      "path": "_attachments/<aa>/<sha256><ext>",
      "sha256": "<sha256>",
      "ext": ".png",
      "byteSize": 68
    }
  ]
}
```

- `journals`: every exported journal (including empty ones), in code-point
  order of name.
- `notes`: every note in an exported journal, in code-point order of `id`.
- `attachments`: every attachment referenced by an exported note and present
  in the store, in code-point order of `path`. Missing attachments are reported
  to the user, not listed.

## Partial export

A writer may export chosen journals instead of the whole library. A partial
export is byte-identical (except `export-info.json`) to a full export of a
library holding only those journals and their notes. Concretely:

- `journals` lists only the chosen journals, and directory names are assigned
  among them alone.
- `notes` lists only their notes; no other note file is written.
- `attachments` lists only blobs referenced by those notes.
- A link to a note in a journal left out stays in stored form,
  `chronicles://note/<id>`, like any link to a note not in the export (see
  [Links](#links)). It dangles after import and reconnects, with no rewrite,
  once the target's journal is imported too.

Nothing marks an export as partial; readers need not tell the difference.
Import is always a merge (see [Import](#import)), so journals and notes absent
from an export are never deleted from the reading library.

## Single-file form

The same tree can be written as one zip file, so it moves as one file (for
example through iCloud Drive, where a folder of thousands of files downloads
one file at a time). Zip, because every platform already reads it:
ZIPFoundation on iOS, Node, Python's `zipfile`, Finder, and Explorer.

Name: writers name the file `<name>.chronicles.zip`. The real extension stays
`.zip`, so file pickers and system type detection treat it as an ordinary zip;
the inner `.chronicles` marks it as an export. Readers decide by content, not
name: a zip with `manifest.json` at its root is an export.

Contents:

- One entry per file in the tree. The entry name is the file's path relative
  to the export root, with `/` separators, as the UTF-8 bytes of the same
  names the folder form uses (`work/<id>.md`, `日記/<id>.md`,
  `_attachments/<aa>/<sha256><ext>`, `manifest.json`, `export-info.json`).
  Directory names are not percent-encoded; percent-encoding applies only to
  link destinations inside notes, exactly as in the folder form.
- Entries sit at the archive root, not under a wrapping folder.
- Extracted entry contents are byte-identical to the folder form's files.
- Writers emit file entries only (no directory entries) and set the UTF-8
  name flag (general purpose bit 11). They write `manifest.json` first, then
  the remaining entries in code-point order of name; order carries no meaning
  for readers.
- Writers publish atomically, like the folder form: write a temp sibling,
  rename into place, refuse an existing destination.

The contract is the extracted tree, never the archive bytes: timestamps,
compression choices, entry order, and extra fields may differ between
writers and between two exports of unchanged data.

A reader must support:

- compression methods 0 (stored) and 8 (deflate); other methods and
  encrypted entries are an error;
- UTF-8 entry names (bit 11 set);
- entries whose sizes and CRC follow the data in a data descriptor (general
  purpose bit 3), which means reading sizes from the central directory;
- Zip64. Writers switch to Zip64 only when needed (more than 65,535 entries,
  or any size or offset at or past 4 GiB), which a large library with many
  attachments can reach;
- ignoring directory entries and creating parent directories implicitly.

A reader must reject, before writing anything, an entry whose name is
absolute, contains a `..` segment or a `\`, or is a symbolic link.

## Encrypted form

The single-file form, sealed, so an export can sit in iCloud Drive, a
backup disk, or an email without being readable there. It opens with the
library's own key, or with the library's recovery code on a device that
doesn't have the key ([encryption.md](encryption.md#keys)), so restoring
needs nothing a person doesn't already keep. Writers offer it next to the
plaintext forms, never in place of them: the plaintext export stays the
copy any tool can read.

```
file   = magic ‖ header ‖ 0x0A ‖ stream
magic  = "chronicles-encrypted-export/1" 0x0A
header = compact JSON on one line (no LF inside), keys in code-point order
stream = the single-file form's zip bytes, sealed as a 0x02 stream
```

Name: writers name the file `<name>.chronicles.encrypted`. Readers decide by
content: a file that starts with `magic` is an encrypted export, whatever
its name. A file that starts with `chronicles-encrypted-export/` and another
version is one made by a later app: readers say so, and read nothing.

### Header

```json
{
  "exportId": "<32 hex>",
  "formatVersion": "2.0",
  "slots": [
    {
      "fingerprint": "<16 hex>",
      "key": "<envelope>",
      "keyring": "<envelope>",
      "type": "library"
    }
  ]
}
```

- `exportId`: 16 random bytes in lowercase hex, new for every export.
- `formatVersion`: the export format of the zip inside (see
  [Versioning](#versioning)), so a reader can refuse an unknown major
  version before asking for a key.
- `slots`: the ways to the **export key** (EK), 32 random bytes made for
  this export alone. Readers ignore slot types they don't know, and fail
  with a clear message when no slot is one they can open.

A `library` slot:

- `fingerprint`: the library key's fingerprint, naming the key without
  revealing it, so a reader knows whether it holds that key.
- `key`: EK in a `0x01` envelope under the **library export key** (HKDF of
  the library key, info `chronicles.v1 export`), AAD kind `export`, record
  id the `exportId`, key id `library`.
- `keyring`: the library key in a `0x01` envelope under the recovery
  wrapping key: the library's `keyring.library` envelope, copied verbatim
  (AAD kind `keyring`, id `library`, key id `recovery`). A writer needs only
  the keyring it already holds, never the recovery code itself.

That is all a reader sees without a key: the format version, an id, the
library key's fingerprint, and the file's size. Journal names, titles, note
counts, attachment names, and dates are inside the stream.

A later `passphrase` slot (EK under a key stretched from a passphrase, as
encryption.md's journal locks) can open an export for someone without the
library's keys; none is defined yet.

### Stream

The zip is sealed exactly as an attachment file is
([encryption.md](encryption.md#attachment-files)): `0x02`, then 64 KiB
chunks under AES-256-GCM with counter nonces, the last chunk flagged in its
nonce. Here:

- The key is the **export stream key**: HKDF of EK, info
  `chronicles.v1 export-stream`.
- The AAD is `chronicles.v1|export-stream|<exportId>|<header sha256>`, where
  `<header sha256>` is the lowercase hex SHA-256 of the header's bytes
  (without the LF). Every chunk is bound to the header, so a header edited
  in any way (a version, a slot swapped in from another export, a byte
  added) fails the first chunk.
- EK is random per export and seals one plaintext, so counter nonces never
  repeat under a key.

Writers seal from file to file, so memory stays at a chunk or two whatever
the library's size, and publish atomically, like the other forms.

### Opening

1. Read `magic` and the header (a reader may refuse a header over 64 KiB);
   refuse an unknown magic version or an unknown major `formatVersion`.
2. Get EK from a slot: a `library` slot whose `fingerprint` names a library
   key this device holds opens with it, asking nothing. Otherwise ask for
   the recovery code, open `keyring` with it, check the opened key's
   fingerprint is the slot's, and open `key`. A code that doesn't open
   `keyring` is the wrong code; say so, and ask again.
3. Open the stream to a temporary file. Every chunk is authenticated before
   anything is imported: a stream that fails partway (tampered, cut short,
   or with bytes after its last chunk) imports nothing and leaves nothing
   behind.
4. Import the temporary file as a single-file export ([Import](#import)).

An export made before the library was removed from iCloud opens with the
recovery code it had then: removing the library retires the key on every
device, but the export carries its own keyring. Its fingerprint tells the
person which code that is.

**Readers that don't read the encrypted form** (the Electron app, which is
maintenance-only) recognize `magic` and refuse the file with a message that
it is an encrypted export, made to be opened by the iPhone or Mac app,
rather than read it as something else.

## Versioning

`formatVersion` is `"<major>.<minor>"`. Readers reject an unknown major version
with a clear error. Minor versions only add optional fields.

Version 1 exports (`"version": 1` in the manifest, block-style YAML
frontmatter, directory name = journal name) and plain Chronicles notes
directories remain importable.

## Import

Importers accept both the folder and the single-file form. A single file is
read as its extracted tree; an encrypted one ([Encrypted form](#encrypted-form))
is opened first, then read as the single file inside.

1. Read `manifest.json` if present; reject an unknown major version.
2. Create every manifest journal, then walk `<dir>/<id>.md` files; a note's
   journal is its directory's manifest journal. Journals match an existing
   journal by ID, then by name ignoring ASCII case. A same-name journal with
   no notes adopts the imported ID; one with notes keeps its own ID and the
   imported notes merge into it.
3. A frontmatter `id` must equal the file name.
4. Body bytes are kept verbatim except rewritten reference destinations.
5. Existing IDs are skipped or replaced per the caller's explicit choice.
6. Import merges into the library. Notes and journals the export does not
   contain are left alone.
