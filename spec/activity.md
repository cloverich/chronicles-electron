# Activity

A capped, append-only log of library changes on one device: what happened,
when, and to what. Deleted notes keep their content in the log for a while,
so a delete can be undone. Status: draft, implemented by the Swift app only.

The log answers "where did that note go?" after the fact, from rows that stay
readable when the note or journal is gone, and makes "sync deleted my notes"
recoverable. It is not edit history (that is note versions, later) and not a
general event store.

## Rows

| Field         | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `id`          | a UUID25 (time-ordered), unique                                            |
| `at`          | timestamp of the change (for a coalesced row, its latest change)           |
| `device`      | the device that wrote the row (a display name; never an account id)        |
| `origin`      | what made the change: `user`, `sync`, or `import`                          |
| `kind`        | below                                                                      |
| `batchId`     | null, or shared by every row of one bulk change, journal delete, or import |
| `noteId`      | the note, for note rows                                                    |
| `journalId`   | the journal: the note's journal after the change, or the journal itself    |
| `title`       | **snapshot** of the note's label at the time; null for journal rows        |
| `journalName` | **snapshot** of the journal's name at the time                             |
| `detail`      | a small JSON object (below)                                                |
| `payload`     | `deleted` rows only, while restorable: the deleted note's file             |

A note's **label** is its title, or when the title is null or empty, the first
non-empty line of its content, trimmed of whitespace and cut to 60 characters
(code points), or null for an empty note.

Rows are listed newest first: by `at`, then by the order they were written.
Rows written by one change share its `at` and are written in the order this
document gives.

### Kinds and detail

| Kind                 | Written when                                  | `detail`                          |
| -------------------- | --------------------------------------------- | --------------------------------- |
| `created`            | a note is created (origin `user` or `sync`)   | `{}`                              |
| `imported`           | a note is created by an import                | `{}`                              |
| `moved`              | a note's journal changes                      | `{"from":"<name>","to":"<name>"}` |
| `renamed`            | a note's title changes                        | `{"from":<title>,"to":<title>}`   |
| `tagged`             | tags are added to a note                      | `{"tags":["…"]}` (sorted)         |
| `untagged`           | tags are removed from a note                  | `{"tags":["…"]}` (sorted)         |
| `edited`             | content, front matter, or `createdAt` changes | `{"edits":<n>}`                   |
| `deleted`            | a note is deleted                             | `{}`, then `{"restoredAt":"…"}`   |
| `restored`           | a deleted note is restored from the log       | `{}`                              |
| `journal.created`    | a journal is created                          | `{}`                              |
| `journal.renamed`    | a journal's name changes                      | `{"from":"<name>","to":"<name>"}` |
| `journal.archived`   | a journal is archived                         | `{}`                              |
| `journal.unarchived` | a journal is unarchived                       | `{}`                              |
| `journal.deleted`    | a journal is deleted                          | `{"notes":<n>}`                   |
| `restore.library`    | the library is replaced from a backup         | `{}`                              |

Moves name journals, not IDs, so a row reads the same after a journal is gone.

### What one change writes

- **Create:** `created` (`imported` when the origin is `import`).
- **Update:** one row per aspect that changed, in this order: `moved`,
  `renamed`, `tagged`, `untagged`, `edited`. An update that changes none of
  them (the same revision, or only `updatedAt`) writes nothing.
- **Delete:** `deleted`, with the note's file (export format, references in
  stored form, exactly the sync note payload) as `payload`.
- **Bulk change:** one row per note that actually changed, under one batch,
  notes in ID order. A note the change leaves as it was writes nothing.
- **Journal delete:** a `deleted` row per note (ID order), then
  `journal.deleted`, all under one batch.
- **Import:** every row the import writes shares one batch, origin `import`.
- **Sync:** received changes write the same rows, origin `sync`, no batch.

Rows are written in the same transaction as the change: a row never exists
without its change, or the reverse. Reads, navigation, search, and rebuilding
derived data write nothing.

### Coalescing

Autosave would otherwise fill the log in an afternoon. A new `edited` or
`renamed` row is merged into the newest row for the same note with the same
kind, origin, and device, with no batch, when that row's `at` is at most 10
minutes before the new change. Merging sets `at` to the new change's time and
refreshes `title` and `journalName`; `edited` adds 1 to `edits`; `renamed`
keeps `from` and takes the new `to`. Coalescing slides: a long writing
session is one row.

## Restore

A `deleted` row with a payload can be restored (one without fails with
`invalidInput`; restoring a note the log has no `deleted` row for fails with
`notFound`):

1. If a note with that ID exists, restoring fails (`conflict`).
2. If the note's journal no longer exists, it is re-created under the same ID
   and the row's `journalName`, or `<name> 2` (3, …) when another journal
   holds that name (ignoring ASCII case). This writes `journal.created`.
3. The note is created from the payload with the same ID, journal, title,
   content, tags, front matter, `createdAt`, and `updatedAt`, so its revision
   is the one it had when deleted. Re-creating the ID removes its tombstone
   ([data-model.md](data-model.md#tombstone)); sync then sends it as a change.
   This writes `restored`.
4. The `deleted` row loses its payload and gains `restoredAt`.

**Restoring a batch** restores every restorable `deleted` row in it, oldest
first, skipping notes that exist; the rows it writes share a new batch.

**Deleting permanently** drops one row's payload now. **Clearing** drops
every row.

## Caps

| Limit           | Value          |
| --------------- | -------------- |
| Rows            | newest 10,000  |
| Payload age     | 30 days        |
| Payload size    | 50 MB in total |
| Coalesce window | 10 minutes     |

After each row is written (not merged), in order: rows past the newest 10,000
are removed; payloads of rows whose `at` is more than 30 days before the new
row's are dropped; then, while payloads (counted as UTF-8 bytes) total more
than 50 MB, the oldest is dropped. A row that loses its payload stays: the
note is listed as deleted, no longer restorable. Removed rows and payloads
are overwritten on disk (SQLite `secure_delete`), not left in free pages.

## Scope

- **Local.** Each device keeps its own log. Changes received through sync are
  logged by the receiving device with origin `sync`.
- **Not exported.** Like tombstones, the log is device history, not library
  content ([export-format.md](export-format.md)).
- **Backed up.** A backup copies the database, log included. Restoring one
  brings back the log as it was, then writes `restore.library`.
- **Erasing** the library erases the log.
- **Encryption (later).** For a note in an encrypted journal, `title`,
  `detail`, and `payload` are sealed under that journal's key; `kind`, times,
  IDs, and the journal name stay readable. Encrypting a journal seals its
  existing rows.

## Vectors

`vectors/activity/cases.json`: each case seeds a library (`library`, loaded
without logging), runs `steps` in order, and lists the log newest first
(`expected`), optionally followed by `notes` that must exist afterwards.

A step has `at` (the time of the change, also used as the note's `updatedAt`),
an optional `origin` (default `user`), an optional `batch` label (for an
import: the steps sharing a label are one import), an `op` with its
arguments, and an optional `error` (`conflict`, `notFound`, `invalidInput`)
the step must fail with. Ops: `createNote`, `updateNote` (fields not given
stay as they are), `deleteNote`, `bulk` (`query` with `journalIds` or `tags`;
`addTag`, `removeTag`, or `changeJournal`), `createJournal`, `renameJournal`,
`archiveJournal` (`archived`), `deleteJournal`, `restore` (the newest
`deleted` row for `noteId`), `restoreBatch` (the batch of the newest row for
`noteId`), `purge` (the newest `deleted` row for `noteId`), and `clear`.

An expected row lists `kind`, `origin`, `at`, `noteId`, `journalId`, `title`,
`journalName`, `batch`, `detail`, and `restorable` (whether it holds a
payload). `batch` is a label, not an ID: rows with the same label must share
a `batchId`, rows with different labels must not, and null means no batch.
`limits` overrides the caps for a case.
