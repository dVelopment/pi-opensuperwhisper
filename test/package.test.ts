import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import manifest from "../package.json" with { type: "json" };
import { FakeHost } from "./harness.ts";

describe("package manifest", () => {
  test("pi and omp load the same TypeScript entry", () => {
    expect(manifest.pi.extensions).toEqual(["./src/index.ts"]);
    expect(manifest.omp.extensions).toEqual(manifest.pi.extensions);
    expect(manifest.files).toContain("src");
  });

  test("the entry's default export registers the extension's handlers", async () => {
    // Load the entry the way the hosts do: from the path the manifest declares.
    const entry = await import(join(import.meta.dir, "..", manifest.pi.extensions[0] ?? ""));
    const host = new FakeHost();
    // Registration only: no events are fired, so the real app is never contacted.
    entry.default(host.api);
    expect(host.events().sort()).toEqual(
      ["agent_end", "agent_settled", "agent_start", "input", "session_before_switch", "session_shutdown", "session_start"].sort(),
    );
  });
});
