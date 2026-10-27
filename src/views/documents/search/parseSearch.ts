import type { NoteQuery } from "../../../contract/notes";
import { isDateToken } from "../../../contract/rules";

/** What a title ends with when sync or a merge import kept a conflicted copy. */
export const CONFLICTED_TITLE = "(conflicted copy)";

export interface ParsedSearch {
  query: NoteQuery;
  /** `in:` names that matched no journal (spec/search.md, "No such journal"). */
  unknownJournals: string[];
}

/** Operators written `name:`, which take a quoted value (`in:"old blog"`). */
const colonOperators = [
  "-in:",
  "in:",
  "-tag:",
  "tag:",
  "title:",
  "text:",
  "date:",
  "before:",
  "after:",
  "is:",
];

/**
 * Parse search text into a NoteQuery, per spec/search.md.
 *
 * @param journals - every journal (archived too), to resolve `in:` names
 */
export function parseSearch(
  text: string,
  journals: { id: string; name: string }[],
): ParsedSearch {
  const journalIds: string[] = [];
  const excludeJournalIds: string[] = [];
  const tags: string[] = [];
  const excludeTags: string[] = [];
  const titles: string[] = [];
  const texts: string[] = [];
  const unknownJournals: string[] = [];
  let date: string | undefined;
  let before: string | undefined;
  let after: string | undefined;

  const add = (list: string[], value: string) => {
    if (value && !list.includes(value)) list.push(value);
  };
  const journalId = (name: string) =>
    journals.find((j) => asciiLower(j.name) === asciiLower(name))?.id;

  for (const term of terms(text)) {
    if (term.operator === undefined) {
      if (hasSearchableText(term.value)) add(texts, term.value);
      continue;
    }
    const value = term.value;
    if (!value) continue;
    switch (term.operator) {
      case "in:": {
        const id = journalId(value);
        if (id) add(journalIds, id);
        else add(unknownJournals, value);
        break;
      }
      case "-in:": {
        const id = journalId(value);
        if (id) add(excludeJournalIds, id);
        break;
      }
      case "#":
      case "tag:":
        add(tags, value);
        break;
      case "-#":
      case "-tag:":
        add(excludeTags, value);
        break;
      case "title:":
        add(titles, value);
        break;
      case "text:":
        if (hasSearchableText(value)) add(texts, value);
        break;
      case "date:":
        if (isDateToken(value)) date = value;
        break;
      case "before:":
        if (isDateToken(value)) before = value;
        break;
      case "after:":
        if (isDateToken(value)) after = value;
        break;
      case "is:":
        if (asciiLower(value) === "conflicted") add(titles, CONFLICTED_TITLE);
        break;
    }
  }

  const query: NoteQuery = {};
  if (journalIds.length) query.journalIds = journalIds;
  if (excludeJournalIds.length) query.excludeJournalIds = excludeJournalIds;
  if (tags.length) query.tags = tags;
  if (excludeTags.length) query.excludeTags = excludeTags;
  if (titles.length) query.titles = titles;
  if (texts.length) query.texts = texts;
  if (date) query.date = date;
  if (before) query.before = before;
  if (after) query.after = after;
  return { query, unknownJournals };
}

/** True when the search can only find nothing: it names journals, none of which exist. */
export function matchesNothing(parsed: ParsedSearch): boolean {
  return !parsed.query.journalIds?.length && parsed.unknownJournals.length > 0;
}

/**
 * Quote a chip's value for search text when it has whitespace, so
 * `in:` + "old blog" reads back as one value.
 */
export function quoteValue(value: string): string {
  const bare = value.replace(/"/g, "");
  return /\s/.test(bare) ? `"${bare}"` : bare;
}

type Term = { operator?: string; value: string };

/** Words, phrases, and operators with their values, in order. */
function terms(text: string): Term[] {
  const result: Term[] = [];
  let i = 0;
  const readQuoted = () => {
    // i is at the opening quote; the phrase runs to the next quote or the end.
    const end = text.indexOf('"', i + 1);
    const value = text.slice(i + 1, end === -1 ? text.length : end);
    i = end === -1 ? text.length : end + 1;
    return value;
  };

  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    if (text[i] === '"') {
      result.push({ value: readQuoted() });
      continue;
    }
    let end = i;
    while (end < text.length && !/\s/.test(text[end]) && text[end] !== '"')
      end++;
    const word = text.slice(i, end);
    i = end;

    const lower = asciiLower(word);
    if (text[i] === '"' && colonOperators.includes(lower)) {
      result.push({ operator: lower, value: readQuoted() });
      continue;
    }
    const colon = colonOperators.find((op) => lower.startsWith(op));
    if (colon) {
      result.push({ operator: colon, value: word.slice(colon.length) });
    } else if (word.startsWith("-#")) {
      result.push({ operator: "-#", value: word.slice(2) });
    } else if (word.startsWith("#")) {
      result.push({ operator: "#", value: word.slice(1) });
    } else {
      result.push({ value: word });
    }
  }
  return result;
}

/** Whether full-text search would see any token: FTS drops punctuation. */
function hasSearchableText(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
