# Search

The search text a person types (or an assistant passes as `query`), how it
becomes a [`NoteQuery`](notes-client.md), and how that query matches notes.
Every client that takes search text parses it this way, so the same text finds
the same notes in every app.

## Syntax

Search text is a sequence of terms separated by whitespace. A term is a word,
a quoted phrase, or an operator.

| Term                | Meaning                                            | NoteQuery           |
| ------------------- | -------------------------------------------------- | ------------------- |
| `word`              | the note contains the word                         | `texts`             |
| `"a phrase"`        | the note contains the phrase                       | `texts`             |
| `text:word`         | same as `word` (`text:"a phrase"` for a phrase)    | `texts`             |
| `#tag`, `tag:tag`   | the note has the tag                               | `tags`              |
| `-#tag`, `-tag:tag` | the note doesn't have the tag                      | `excludeTags`       |
| `in:name`           | the note is in the journal                         | `journalIds`        |
| `-in:name`          | the note isn't in the journal                      | `excludeJournalIds` |
| `title:word`        | the title contains the text                        | `titles`            |
| `date:D`            | created in that year, month, or day                | `date`              |
| `before:D`          | created before D                                   | `before`            |
| `after:D`           | created on or after D                              | `after`             |
| `is:conflicted`     | a conflicted copy (title ends `(conflicted copy)`) | `titles`            |

`D` is `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`.

### Reading the text

Read left to right:

1. Whitespace separates terms and is otherwise ignored.
2. A `"` starts a quoted phrase, which runs to the next `"` or the end of the
   text (a phrase still open at the end counts, so results don't jump while
   one is typed). The quotes are not part of it. A `"` in the middle of a word
   ends the word and starts a phrase: `soup"stock pot"` is `soup` and
   `"stock pot"`.
3. Otherwise a word runs to the next whitespace or `"`.
4. A word that is exactly an operator written with a colon (`in:`, `-in:`,
   `tag:`, `-tag:`, `title:`, `text:`, `date:`, `before:`, `after:`, `is:`)
   followed directly by `"` takes the quoted phrase as its value:
   `in:"old blog"`, `title:"status update"`, `-in:"old blog`. This is how a
   value with spaces is written; `in:old blog` is the journal `old` and the
   word `blog`. Values can't contain `"`.
5. A word that starts with an operator takes the rest of the word as the
   value: `in:work`, `#idea`, `-#draft`, `date:2026-10`.

Operator names match ignoring ASCII case (`In:work`, `TITLE:plan`). Any other
word, colon or not, is a word: `10:30`, `http://example.com`, and `foo:bar`
search as text.

### Values

- **Tags** are taken as written, without the `#` or `tag:`: `#Idea` is the tag
  `Idea`.
- **Journals** name a journal by its name, ignoring ASCII case, among all
  journals (archived ones too). A name that matches no journal goes to
  `unknownJournals` (see [No such journal](#no-such-journal)).
- **Dates** that aren't `YYYY[-MM[-DD]]` are ignored. `date:`, `before:`, and
  `after:` each hold one value; a later one replaces an earlier one.
- **`is:`** knows only `conflicted`; any other value is ignored.
- **Duplicates:** a list keeps the first of equal values, in order of
  appearance. `#a #a` is one tag; `#a #A` is two.

### Unfinished operators

An operator without a usable value is ignored rather than searched as text,
so results hold steady while it's typed: `#`, `-#`, `in:`, `in:""`, `title:`,
`date:`, `date:20`, `is:con`. So is a word or phrase with no letters or digits
(`-`, `--`, `"..."`), which full-text search could never match.

A journal name is different: `in:wo` is a finished operator naming a journal
that doesn't exist, so while `in:work` is being typed the list is empty until
the name is complete. Clients suggest journal names as `in:` is typed.

### No such journal

`unknownJournals` lists, in order and without duplicates, the `in:` names that
matched no journal. When `journalIds` is empty and `unknownJournals` isn't,
the search finds nothing: naming a journal narrows the search, so naming only
missing ones never widens it to everything. A client may say which name
matched nothing. An `in:` that does match keeps its results:
`in:work in:nowhere` finds the notes in `work`, as `journalIds` match any.

A `-in:` naming no journal excludes nothing and is ignored.

### Chips

A client may show finished operators as chips (tokens) beside the text, or
hold them apart from it. A chip is the operator it stands for: the query is
the same as if the chip were written into the text, quoted where its value
has spaces.

## Matching

The query matches notes as [notes-client.md](notes-client.md) defines, in
short:

- **Kinds combine with AND:** a note must pass every kind of filter given.
- **`texts`:** each term must match the title or content, so every word and
  phrase must be found. A term matches as a phrase of whole words, in order,
  except that its last word may be the start of a longer one (`recip` finds
  `recipe`, `"chicken sou"` finds `chicken soup`). Case and punctuation are
  ignored. Hosts may stem, so vectors use plain words.
- **`titles`:** each is a substring of the title, ignoring ASCII case.
- **`tags`:** the note has any of them, matched exactly (case counts).
  `excludeTags`: the note has none of them.
- **`journalIds`:** the note is in any of them. `excludeJournalIds`: in none.
- **Dates** compare to `createdAt` (UTC): `date` is a prefix of it; `before`
  keeps `createdAt < before`, `after` keeps `createdAt >= after`.

Results are newest first.

## Parameters beside the text

A tool that takes other arguments with the search text (an assistant's
`search_notes`, Shortcuts' Find Notes) applies each as if its operator were
written after the text: a journal is `in:` (it is never a journal that
doesn't exist; that argument is an error), a tag is `#tag`, and a date is
`before:`/`after:` (so it replaces one in the text). A whole-day "to" date is
`before:` the following day.

## Vectors

`vectors/search/cases.json` holds `journals` (`{id, name}`) and `cases`. Each
case has `text` and the expected `query` (a NoteQuery; a field left out is
empty) and `unknownJournals` (left out when empty). An implementation passes
when parsing each case's `text` against `journals` yields exactly that query
and those names, list order included.
