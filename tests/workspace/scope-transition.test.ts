import assert from "node:assert/strict";
import { test } from "node:test";

import { assertSameRepositorySet } from "../../src/workspace/project.ts";

test("a scope-transition execution uses the planned repository set", () => {
  assert.doesNotThrow(() => assertSameRepositorySet([{ url: "https://example.test/a.git", baseBranch: "main" }], undefined));
  assert.doesNotThrow(() =>
    assertSameRepositorySet(
      [
        { url: "https://example.test/a.git", baseBranch: "main" },
        { url: "https://example.test/b.git", baseBranch: "release" },
      ],
      [
        { url: "https://example.test/b.git", baseBranch: "release" },
        { url: "https://example.test/a.git", baseBranch: "main" },
      ],
    ),
  );
  assert.throws(() => assertSameRepositorySet([{ url: "https://example.test/a.git", baseBranch: "main" }], [{ url: "https://example.test/b.git", baseBranch: "main" }]), /scope_transition_plan_stale/);
  assert.throws(
    () => assertSameRepositorySet([{ url: "https://example.test/a.git", baseBranch: "main" }], [{ url: "https://example.test/a.git", baseBranch: "release" }]),
    /scope_transition_plan_stale/,
  );
});
