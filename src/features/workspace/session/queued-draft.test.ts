import assert from "node:assert/strict";
import { test } from "node:test";
import { withQueuedDraft } from "./queued-draft.ts";

test("queued text and images append without losing the existing draft or duplicating attachments", () => {
  const draft = { text: "existing", files: [{ path: "C:/a.png", name: "a.png" }], snippets: [], collaboration: "plan" as const };
  const next = withQueuedDraft(draft, { id: "q", text: "queued", images: ["C:/a.png", "C:\\b.png", "C:\\b.png"] });
  assert.equal(next.text, "existing\nqueued");
  assert.deepEqual(next.files, [...draft.files, { path: "C:\\b.png", name: "b.png" }]);
  assert.equal(next.snippets, draft.snippets);
  assert.equal(next.collaboration, "plan");
  assert.equal(draft.text, "existing");
});
