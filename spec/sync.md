# Sync

How devices exchange a library through a server they all reach (CloudKit's
private database first). The rules here are transport-neutral: a transport
moves records and reports what the server holds; everything below decides
what to send and how to apply what arrives. Status: draft, implemented by the
Swift app only.

Goals, in order: never lose a change; converge (every device ends with the
same library); stay quiet (no change bounces between devices forever).

## Records

Every journal, note, and attachment is one record, named by kind and id.

| Kind         | Id              | Payload                                            | Revision          |
| ------------ | --------------- | -------------------------------------------------- | ----------------- |
| `journal`    | journal ID      | `{"archivedAt":…,"id":"…","name":"…"}` (see below) | sha256 of payload |
| `note`       | note ID         | the note file, references in stored form           | the note revision |
| `attachment` | `<sha256><ext>` | the bytes                                          | the `sha256`      |

- **Journal payload:** compact JSON with keys in that order, strings encoded as
  in [export-format.md](export-format.md#frontmatter-lines), `archivedAt`
  `null` when not archived. Local `createdAt`/`updatedAt` are not synced.
- **Note payload:** exactly the bytes whose hash is the note's revision
  ([data-model.md](data-model.md#revision)), so a receiver can verify it.
  The journal is referenced by ID, so a rename touches one record.
- **Attachments** are immutable and never deleted by sync.

**Parents.** A note record also carries `parents`: compact JSON
`{"parents":[…],"revision":"…"}` naming the revisions the note's current
version was made from ([versions.md](versions.md)) and the revision they
belong to. A note without versions sends none. A receiver uses them only when
`revision` equals the received note's revision, since a writer that doesn't
know the field (Chronicles 0.5) leaves the previous value in place; otherwise
the record has no parents. Tombstones carry none. Parents never change change
detection: they travel with a note's save and are not a change of their own.

**Deletes are records too.** Deleting a journal or note sends a _tombstone_:
the same record with no payload, marked deleted, whose revision is empty. A
tombstone is saved like any other change, so the server refuses it when
someone else changed the record first (below): an edit is never lost to a
delete sent before the edit arrived. Servers never remove records; compacting
old tombstones is defined later. Sync does not read the library's tombstones
([data-model.md](data-model.md#tombstone)); deletions are found from sync
state.

Revisions give equality only. A record whose payload doesn't match its
revision, or doesn't parse, is skipped and reported, never applied.

## Sync state

Each device keeps, per record it has exchanged with the server:

| Field       | Meaning                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| `revision`  | the revision last sent to or received from the server (empty: a tombstone)             |
| `base`      | that revision's payload (journals and notes), for three-way merges                     |
| `transport` | opaque data the transport keeps with the record (CloudKit: the record's system fields) |

Sync state is local, like derived data: never exported, never synced.

## Finding local changes

Pending changes come from comparing the library with the sync state, never
from hooks on individual writes, so every writer counts: the editor, imports,
bulk changes, another process (the share extension), a migration.

| Library              | Sync state     | Pending                     |
| -------------------- | -------------- | --------------------------- |
| record, revision `v` | none           | save                        |
| record, revision `v` | `s ≠ v`        | save                        |
| record, revision `v` | `s = v`        | nothing                     |
| no record            | `s`, not empty | tombstone (notes, journals) |
| no record            | empty or none  | nothing                     |

Saves go journals first, then notes, then attachments (a note may reach
another device before its attachment; it shows the image once it arrives).
Tombstones go notes first, then journals.

**Delete guard:** when more than 50 note tombstones are pending at once, no
tombstone is sent until the person confirms them; saves still go. Confirming
releases the tombstones pending at that moment.

Every save is conditional on the server still holding the version the device
last saw (CloudKit: the record's change tag), or on the record not existing
yet. When the server accepts a save, the device records the revision it sent;
if the library changed meanwhile, the record is simply still pending. When the
server refuses a save because it holds another version (`serverRecordChanged`),
the device applies the server's version as if it had been received, below,
and sends what results.

## Applying received records

Applying is idempotent: a duplicate delivery changes nothing. Records may
arrive in any order relative to each other (a note before its journal, an
attachment after its note); versions of one record arrive in the order the
server saved them. Within a batch, apply journals, then attachments, then
notes, then note tombstones, then journal tombstones.

After applying a received record with revision `r`, its sync state is
`{revision: r, base: payload}`; the library holds either that record (now
clean) or a merge of it with local changes (still pending, so it is sent).

### Notes

With local note `L`, received note `R` (revision `r`) and sync state `s`/`B`:

1. **No local note.** If there's no sync state, or `s ≠ r`, create `R`. A
   local delete of a note someone else changed is undone: the edit survives.
   If `s = r`, the local delete stands and stays pending.
2. **Same revision** (`L = r`): nothing changes.
3. **Local clean** (`L = s`): take `R`.
4. **Both changed:** three-way merge of `B`, `L`, `R`, field by field.

Merge, for `journal`, `title`, `createdAt`, `content`, and each `frontMatter`
key (a missing key is a value): if `L` equals `B` take `R`; if `R` equals `B`
take `L`; if `L` equals `R` take it; otherwise the field conflicts. `tags`
merge as sets: a tag is kept when both sides have it or one side added it
(it isn't in `B`), so either side can add or remove. `updatedAt` is the later
of the two (code-point order). Without a base in the sync state (state lost,
a tombstone, or a library joining), the base is the local version whose
revision is the first of `R`'s parents the device holds
([versions.md](versions.md)), when there is one. Without either, every
differing field conflicts and tags are the union.

- A conflict in `title` or `content` **keeps both**: the note takes `R`'s value
  for its conflicting fields, and a _conflicted copy_ holds `L` unchanged
  except: a new ID, title `<L's title, or "Untitled"> (conflicted copy)`,
  front-matter key `conflictOf` = the original's ID, `updatedAt` = now.
- A conflict in `journal`, `createdAt`, or a front-matter key alone takes `R`'s
  value; no copy.

A note whose journal doesn't exist locally recreates the journal under the
same ID: named from the journal's sync-state base when there is one,
otherwise `Recovered` (made unique as below). The recreated journal is
pending, so the server learns it survived.

**Received note tombstone.** If the local note is clean (`L = s`), delete it.
If it changed since or was never synced, keep it; its sync state is now a
tombstone, so it is pending and sent again: the edit survives.

### Journals

A received journal is applied like a note, merging `name` and `archivedAt`
with the same rule; a conflict in either takes `R`'s value.

Names are unique ignoring ASCII case. When a received journal's name is held by
another local journal, the one whose ID sorts later (code point) is renamed to
`<name> 2` (or `3`, … until free; the name is shortened to keep within 25
characters). Each device makes the same choice, so they converge.

**Received journal tombstone:** delete its clean notes as if their tombstones
had arrived. If notes remain (changed or never synced), or it is the last
journal, keep the journal (pending, so it is sent again). Otherwise delete it.

### Attachments

Store the bytes. If their hash doesn't match the record's ID, discard them.

## Joining and detaching

Turning sync off, erasing the library, and restoring a backup clear the sync
state; the library itself is untouched. Turning sync on with a non-empty
library is therefore a join: identical records match, records only on this
device are sent, records that differ keep both (no base), and nothing is
deleted. Restoring a backup on a synced device brings its notes back to every
device rather than being undone by the next sync.

## Vectors

`vectors/sync/<area>.json` holds scenarios over several devices sharing one
server:

```json
{
  "description": "…",
  "scenarios": [
    {
      "name": "…",
      "devices": { "a": "basic", "b": null },
      "steps": [
        { "device": "a", "op": "updateNote", "request": { … }, "response": { … } },
        { "sync": "a" },
        { "sync": "b" },
        { "device": "b", "op": "getNote", "request": { … }, "response": { … } }
      ]
    }
  ]
}
```

Each device starts from `vectors/contract/libraries/<library>.json`, or empty
for `null`, with empty sync state; the server starts empty. A `device` step is
a NotesClient step ([notes-client.md](notes-client.md#fixtures)) run on that
device, with the same placeholders; bindings are shared across devices. A
`sync` step has the device receive everything new on the server, send all
pending changes, and repeat until neither side has anything new. A `reset`
step forgets that device's sync state, as turning sync off does (its library
and versions stay), so its next `sync` is a join. The server
holds the latest version of each record and refuses stale saves, nothing more.
A scenario passes when every step does.
