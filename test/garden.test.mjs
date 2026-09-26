import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  gardenPathCandidates,
  resolveGardenPath,
  activeLocaleSet,
  runGardenDryDiff,
} from "../src/garden.mjs";

describe("garden paths", () => {
  it("primary path is <root>/<repoBasename>/<rel>", () => {
    const p = resolveGardenPath(
      "/checkouts",
      "your-org/your-site",
      "locales/en/common.json",
    );
    assert.equal(p, "/checkouts/your-site/locales/en/common.json");
  });

  it("lists fallback candidates", () => {
    const c = gardenPathCandidates(
      "/checkouts",
      "your-org/your-site",
      "locales/en/common.json",
    );
    assert.equal(c[0], "/checkouts/your-site/locales/en/common.json");
    assert.equal(c[1], "/checkouts/locales/en/common.json");
    assert.equal(c.length, 3);
  });
});

describe("localeTiers", () => {
  it("activeLocaleSet reads localeTiers.active", () => {
    const set = activeLocaleSet({
      localeTiers: { active: ["de", "fr"], deferred: ["ja"] },
    });
    assert.ok(set.has("de"));
    assert.ok(set.has("fr"));
    assert.equal(set.has("ja"), false);
  });

  it("null when no tiers", () => {
    assert.equal(activeLocaleSet({}), null);
  });
});

describe("runGardenDryDiff", () => {
  it("skips deferred locales and diffs active with path fallbacks", async () => {
    const root = join(tmpdir(), `lc-garden-${Date.now()}`);
    const repoDir = join(root, "your-site");
    await mkdir(join(repoDir, "locales", "en"), { recursive: true });
    await mkdir(join(repoDir, "locales", "de"), { recursive: true });
    await writeFile(
      join(repoDir, "locales", "en", "common.json"),
      JSON.stringify({
        page: "common",
        locale: "en",
        strings: ["Hello", "World"],
      }),
    );
    await writeFile(
      join(repoDir, "locales", "de", "common.json"),
      JSON.stringify({
        page: "common",
        locale: "de",
        strings: { Hello: "Hallo" },
      }),
    );
    const manifestPath = join(root, "garden.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        localeTiers: {
          active: ["de"],
          deferred: ["ja"],
        },
        repos: [
          {
            repo: "your-org/your-site",
            catalogs: [
              {
                id: "common",
                source: "locales/en/common.json",
                target: "locales/de/common.json",
                locale: "de",
              },
              {
                id: "common",
                source: "locales/en/common.json",
                target: "locales/ja/common.json",
                locale: "ja",
              },
            ],
          },
        ],
      }),
    );

    try {
      const summary = await runGardenDryDiff({
        manifest: manifestPath,
        root,
      });
      assert.equal(summary.skippedDeferred, 1);
      assert.equal(summary.walked, 1);
      assert.equal(summary.withDelta, 1);
      assert.equal(summary.totalMissing, 1);
      const deferred = summary.results.find((r) => r.status === "deferred_locale");
      assert.ok(deferred);
      assert.equal(deferred.locale, "ja");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
