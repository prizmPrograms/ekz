import assert from "node:assert/strict";
import test from "node:test";
import { queriesForGenre } from "../src/google.js";

test("queriesForGenre combines multiple preference genres without duplicates", () => {
  assert.deepEqual(
    queriesForGenre(["sweets", "view"]),
    ["カフェ", "スイーツ", "ベーカリー", "展望台", "海岸", "公園"],
  );
});
