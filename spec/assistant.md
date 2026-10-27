# Assistant access

Tools an app offers an assistant (a language model acting for the person) over
the library, and the scope that bounds them. Status: draft, implemented by the
Swift Mac app as an MCP server. The tools are MCP tools; how they are carried
(transport, authentication) is per app.

An assistant is a delegate: it sees and changes only what the person granted,
and every change it makes can be undone. Until per-journal locks
([encryption.md](encryption.md#journal-access-later)) the scope is enforced by
the app, not by keys.

## Scope

A grant has:

| Field      | Meaning                                                                            |
| ---------- | ---------------------------------------------------------------------------------- |
| `journals` | the journal IDs the assistant may see; new journals are not added                  |
| `access`   | `read`, `add` (read, create notes, append to notes), or `edit` (also update notes) |

Access is off until the person grants it. Outside the grant, things don't
exist for the assistant:

- A note is visible when its journal is in `journals`. Reading, appending to,
  or updating any other note fails `not_found`, as for a note that doesn't
  exist.
- A search only ever returns visible notes. A search that names only other
  journals (`in:`) returns nothing.
- Tags are counted over visible notes only.
- An attachment is visible through a visible note whose content references it.

An assistant never deletes notes, moves them between journals, changes
journals, or touches settings, sync, or export.

## Changes

Each change is a normal library write with origin `assistant`
([activity.md](activity.md), [versions.md](versions.md)): it writes activity
rows and a version, assistant versions are never coalesced, and sync carries it
like any change. `updatedAt` is the time of the write.

- **Create:** a note in a visible journal, with the content given, an optional
  title (blank is none), and optional tags (normalized as the data model
  says).
- **Append:** the note's content, without trailing line breaks, then a blank
  line, then the text without trailing line breaks, then one line break. An
  empty note becomes the text and one line break. Title and tags stay.
- **Update:** fields given replace the note's; fields not given stay. It
  takes the `revision` the assistant last read and fails `conflict` when the
  note has changed since, so an assistant can't overwrite an edit it hasn't
  seen.

## Tools

Results are JSON objects (MCP `structuredContent`, also given as text).
Timestamps are as stored. Notes are returned with their content in stored
form: links as `chronicles://note/<id>`, attachments as
`chronicles://attachment/<sha256><ext>`.

| Tool              | Access | Arguments                                                                 | Result                                                    |
| ----------------- | ------ | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| `list_journals`   | read   | none                                                                      | `journals`: `id`, `name`, `archived`, `noteCount`         |
| `list_tags`       | read   | none                                                                      | `tags`: `tag`, `count`, most used first                   |
| `search_notes`    | read   | `query`, `journal`, `tag`, `from`, `to`, `limit`, `cursor` (all optional) | `notes` (rows), `nextCursor` when more match              |
| `read_note`       | read   | `id`                                                                      | the note                                                  |
| `read_attachment` | read   | `noteId`, `file` (`<sha256><ext>`)                                        | an image as MCP image content; any other file as its size |
| `create_note`     | add    | `journal`, `content`, `title`, `tags`                                     | the note                                                  |
| `append_to_note`  | add    | `id`, `text`                                                              | the note                                                  |
| `update_note`     | edit   | `id`, `revision`, `title`, `content`, `tags`                              | the note                                                  |

A tool the grant's access doesn't allow is not listed, and calling it fails
`unsupported`.

- **`journal`** is a visible journal's ID or its name (case-insensitive).
- **`search_notes`:** `query` is the app's search syntax
  ([search.md](search.md): words, quoted phrases, `#tag`, `-#tag`, `in:name`,
  `in:"a name"`, `-in:`, `title:`, `date:2026-10`, `before:`, `after:`).
  `journal` and `tag` add to it as `in:` and `#tag` would (an unknown
  `journal` fails `not_found`), and `from` and `to` narrow its dates
  ([search.md](search.md#parameters-beside-the-text)). `from` and `to` are dates
  (`YYYY-MM-DD`, UTC), inclusive, on `createdAt`. Newest first by
  `createdAt`. `limit` defaults to 20, at most 100. `cursor` is a previous
  result's `nextCursor`.
- **A row** has `id`, `title`, `journal` (name), `createdAt`, `updatedAt`,
  `tags`, and `excerpt` (plain text, about 220 characters).
- **A note** has `id`, `title`, `journal`, `journalId`, `tags`, `createdAt`,
  `updatedAt`, `revision`, `content`, and `attachments` (the `<sha256><ext>`
  files its content references).
- **`read_attachment`** returns images up to 5 MB.

Errors are tool errors (MCP `isError`) whose text starts with the NotesClient
error code: `not_found`, `conflict`, `invalid_input`, or `unsupported`.
