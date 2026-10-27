import { assert } from "chai";
import fs from "fs";
import { describe, test } from "node:test";
import path from "path";
import { parseSearch } from "./parseSearch";

const vectors = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "spec/vectors/search/cases.json"),
    "utf8",
  ),
);

describe("parseSearch (spec/vectors/search)", function () {
  for (const c of vectors.cases) {
    test(c.name, function () {
      const parsed = parseSearch(c.text, vectors.journals);
      assert.deepEqual(parsed.query, c.query);
      assert.deepEqual(parsed.unknownJournals, c.unknownJournals ?? []);
    });
  }
});
