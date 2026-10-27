# Versions

A note's past states on one device, so an earlier version can be read and
brought back. Status: draft, implemented by the Swift app only.

Versions are edit history: what a note said, version by version. The
[activity log](activity.md) is the other half: what happened across the
library, and undoing deletes. Each version names the versions it was made
from (its _parents_), and sync carries a note's parents, so devices that
lost their sync state can still merge against a version they share.

## Versions

| Field      | Meaning                                                                            |
| ---------- | ---------------------------------------------------------------------------------- |
| `noteId`   | the note                                                                           |
| `revision` | the version's revision ([data-model.md](data-model.md#revision))                   |
| `parents`  | revisions it was made from: none, one (an edit), or two (a merge)                  |
| `at`       | the time of the write (for a replaced version, the latest write)                   |
| `device`   | the device that wrote it (a display name, as in activity.md)                       |
| `origin`   | `user`, `sync`, `import`, `restore`, or `existing` (below)                         |
| `file`     | the note file (export format, references in stored form), whose hash is `revision` |

A note's versions are listed newest first: the reverse of the order they were
written. Once a note has versions, the newest is the note as it is now.
Parents may name revisions this device doesn't hold (another device's version,
or one thinned away).

### What writes a version

Every write that changes a note's revision writes or replaces one version:

| Write                                                   | Version                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| Create (any origin)                                     | origin of the write, no parents                                 |
| Update (the editor, bulk, import)                       | origin of the write, parents: the previous revision             |
| Received from sync, taken whole                         | origin `sync`, parents: the record's parents, else as an update |
| Received from sync, merged                              | origin `sync`, parents: the local and the received revision     |
| Restoring a version (below)                             | origin `restore`, parents: the previous revision                |
| Restoring a delete ([activity.md](activity.md#restore)) | origin `restore`, no parents                                    |

A merge whose result is the received note is taken whole. A conflicted copy
made by a merge ([sync.md](sync.md#notes)) is a create.

- **Existing notes.** A note written before versions existed has none. When
  it is first updated, its state before the update is recorded first: origin
  `existing`, `at` its `updatedAt`, no parents. So the first edit after
  upgrading can be undone.
- **Touches.** A write that changes nothing but `updatedAt` and `pinnedAt`
  (pinning, say) replaces the newest version: the new revision and file, the
  replaced version's `at`, `device`, `origin`, and `parents`. With no versions
  yet, it writes none.

### Coalescing

Autosave writes every few seconds. A new version replaces the note's newest
version, taking its `parents`, instead of being added when:

- both have origin `user`, or both `sync`;
- both were written by the same device;
- neither has more than one parent (a merge is kept); and
- both `at` fall in the same 10-minute window: the same UTC date, hour, and
  ten minutes (`10:20:00.000` to `10:29:59.999`).

Windows don't slide, so a long writing session keeps a version every ten
minutes. `restore` and `existing` versions are never replaced, so whatever a
restore replaced, and the note as it was before versions, stay.

### Thinning

After a version is added (not replaced), the note's versions are thinned:
among those whose `at` is more than 30 days before the new version's, only the
last written of each UTC calendar day is kept. The newest version is never
removed. Removing a version splices it out: a version that named it as a
parent names its parents instead, without repeats, in order.

| Limit           | Value                        |
| --------------- | ---------------------------- |
| Coalesce window | 10 minutes, aligned to UTC   |
| Full history    | 30 days                      |
| After that      | one version per note per day |

## Restoring a version

Restoring version `v` of a note updates the note to `v`'s title, content,
tags, `createdAt`, and front matter, except `pinnedAt`, which stays as it is.
The note stays in its journal, and `updatedAt` is now. It is an ordinary
update otherwise: activity rows as for an edit, a new revision that sync
sends. Restoring the newest version changes nothing. Restoring a revision the
note has no version of fails with `notFound`.

## Scope

- **Local.** Each device keeps its own versions; only `parents` travel with
  synced notes ([sync.md](sync.md#records)). Received changes are recorded as
  versions by the receiving device, so devices that sync often hold similar
  histories.
- **Deleting** a note removes its versions. The activity log keeps the
  deleted note's file, which is how a delete is undone; the restored note
  starts a new history.
- **Not exported.** Like the activity log, versions are device history
  ([export-format.md](export-format.md)). An import records versions as
  writes with origin `import`.
- **Backed up.** A backup copies the database, versions included.
- **Erasing** the library erases its versions.
- **Attachments** a retained version references are in use
  ([data-model.md](data-model.md#attachment)).
- **Encryption (later).** In phase E1 the local library is plaintext, versions
  included. Locking a journal (E2) seals its versions like its activity rows.

## Vectors

`vectors/versions/cases.json`: each case seeds a library (`library`, loaded
without versions or activity), runs `steps` in order, and lists each named
note's versions newest first (`expected`, by note ID).

A step has `at` (the time of the write, also the note's `updatedAt` unless
the step gives one), an optional `origin` (default `user`), an `op` with its
arguments, and an optional `error` the step must fail with. Ops:
`createNote`, `updateNote` (fields not given stay as they are), `pin`
(`pinned`: true or false; `updatedAt` stays), `deleteNote`, `restoreDelete`
(the newest `deleted` activity row for `id`), and `restoreVersion` (`version`:
an index into the note's versions, newest first, before the step).

An expected version lists `at`, `origin`, `title`, `content`, `pinned`
(whether its front matter has `pinnedAt`), and `parents` as indexes into the
same list. Every parent in these cases is a version the device holds.
