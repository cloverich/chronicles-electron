import { when } from "mobx";
import { describe, expect, it, vi } from "vitest";
import { createMemoryNotesClient } from "../../contract/memory";
import { JournalsStore } from "../../hooks/stores/journals";
import { fakeSettings } from "../../test/fakes";
import { SearchStore } from "./SearchStore";

const TOPICS = "03awvyp9xobkv9t1jmmtiz0bp";

const dates = [
  "2023-05-01T09:00:00.000Z",
  "2023-11-01T09:00:00.000Z",
  "2024-01-01T00:00:00.000Z",
  "2024-02-01T09:00:00.000Z",
  "2024-03-01T09:00:00.000Z",
];

async function setup(tokens: string[]) {
  const notes = createMemoryNotesClient({
    journals: [{ id: TOPICS, name: "topics" }],
    notes: dates.map((createdAt, i) => ({
      id: `03b0000000000000000000000${i}`,
      journalId: TOPICS,
      title: createdAt.slice(0, 10),
      content: "",
      createdAt,
      updatedAt: createdAt,
    })),
  });
  await notes.ready;
  const journals = new JournalsStore(
    notes,
    fakeSettings({ defaultJournal: "topics" }),
    [{ id: TOPICS, name: "topics", archived: false, noteCount: dates.length }],
    "topics",
  );
  const store = new SearchStore(notes, journals, vi.fn(), tokens, {
    lastRepairTime: null,
  });
  return { store, notes };
}

const settle = (store: SearchStore) => when(() => !store.loading);
const titles = (store: SearchStore) => store.docs.map((d) => d.title);

describe("SearchStore date bounds", () => {
  it("keeps before: and after: across pages, and counts with them", async () => {
    const { store } = await setup(["after:2023-06", "before:2024-03"]);
    store.pageSize = 2;
    store.search();
    await settle(store);

    expect(store.count).toBe(3);
    expect(titles(store)).toEqual(["2024-02-01", "2024-01-01"]);

    store.next();
    await settle(store);
    expect(titles(store)).toEqual(["2023-11-01"]);
    expect(store.hasNext).toBe(false);
    expect(store.searchTokens).toEqual(["after:2023-06", "before:2024-03"]);

    store.prev();
    await settle(store);
    expect(titles(store)).toEqual(["2024-02-01", "2024-01-01"]);
    expect(store.hasPrev).toBe(false);
  });

  it("splits a journal at a date with no gap or overlap", async () => {
    const { store, notes } = await setup([]);
    await settle(store);
    const before = await notes.countNotes({ before: "2024-01-01" });
    const after = await notes.countNotes({ after: "2024-01-01" });
    expect(before.count + after.count).toBe(dates.length);
    expect(after.count).toBe(3);
  });

  it("gives bulk edits the date bounds", async () => {
    const { store } = await setup(["before:2024"]);
    await settle(store);
    expect(store.query).toMatchObject({ before: "2024" });
    expect(store.query).not.toHaveProperty("cursor");
  });
});
