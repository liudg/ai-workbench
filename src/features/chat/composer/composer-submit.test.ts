import assert from "node:assert/strict";
import { test } from "node:test";

import { decideSlash, decideSubmit, effortForModel } from "./composer-submit.ts";

const base = {
  text: "你好",
  supportsPlan: true,
  supportsReview: true,
  planOn: false,
  imagesOn: true,
  attached: [] as { name: string; path: string }[],
  editingId: null as string | null,
  pendingId: null as string | null,
  composerLocked: false,
};

test("plan and review commands never become a chat message", () => {
  assert.deepEqual(decideSubmit({ ...base, text: " /plan " }), {
    type: "toggle-plan",
    mode: "plan",
  });
  assert.deepEqual(decideSubmit({ ...base, text: "/plan", planOn: true }), {
    type: "toggle-plan",
    mode: "default",
  });
  assert.deepEqual(decideSubmit({ ...base, text: "/plan 先看结构" }), {
    type: "plan-message",
    text: "先看结构",
  });
  assert.deepEqual(decideSubmit({ ...base, text: "/review" }), { type: "open-review" });
  assert.deepEqual(decideSubmit({ ...base, text: "/plan", supportsPlan: false }).type, "send-images");
});

test("queue edit, pending answer, and image send stay distinct", () => {
  assert.deepEqual(
    decideSubmit({
      ...base,
      text: "改一下",
      editingId: "q1",
      attached: [{ name: "a.png", path: "C:/a.png" }],
    }),
    { type: "update-queue", id: "q1", text: "改一下", images: ["C:/a.png"] },
  );
  assert.equal(
    decideSubmit({ ...base, text: "  ", editingId: "q1", imagesOn: false }).type,
    "noop",
  );
  assert.deepEqual(decideSubmit({ ...base, text: "好", pendingId: "p1" }), {
    type: "answer",
    promptId: "p1",
    text: "好",
  });
  assert.equal(decideSubmit({ ...base, text: "好", pendingId: "p1", composerLocked: true }).type, "noop");
  assert.deepEqual(
    decideSubmit({ ...base, text: "", attached: [{ name: "a.png", path: "C:/a.png" }] }),
    { type: "send-images", text: "", images: ["C:/a.png"] },
  );
});

test("image agents keep real paths for non-image files added to chat", () => {
  assert.deepEqual(
    decideSubmit({
      ...base,
      text: "看这个",
      attached: [
        { name: "a.png", path: "C:/a.png" },
        { name: "notes.txt", path: "C:/work/notes.txt" },
      ],
    }),
    {
      type: "send-images",
      text: "看这个\n\n附件：C:/work/notes.txt",
      images: ["C:/a.png"],
    },
  );
});

test("agents without images append file names and keep slash attachments", () => {
  const attached = [{ name: "notes.txt", path: "C:/notes.txt" }];
  assert.deepEqual(decideSubmit({ ...base, imagesOn: false, text: "看这个", attached }), {
    type: "send-text",
    text: "看这个\n\n附件：notes.txt",
    clearAttachments: true,
  });
  assert.deepEqual(decideSubmit({ ...base, imagesOn: false, text: "/help", attached }), {
    type: "send-text",
    text: "/help",
    clearAttachments: false,
  });
  assert.equal(decideSubmit({ ...base, text: "好", composerLocked: true }).type, "noop");
});

test("slash menu and effort follow the same rules as the composer", () => {
  assert.deepEqual(decideSlash({ name: "/review" }, { supports_review: true }, false), { type: "review" });
  assert.deepEqual(decideSlash({ name: "/plan" }, { supports_plan: true }, true), {
    type: "toggle-plan",
    mode: "default",
  });
  assert.deepEqual(decideSlash({ name: "/help", takes_args: true }, {}, false), {
    type: "fill",
    text: "/help ",
  });
  assert.equal(
    effortForModel({ default_effort: "medium", efforts: [{ id: "low" }, { id: "medium" }] }, "low"),
    "low",
  );
  assert.equal(
    effortForModel({ default_effort: "medium", efforts: [{ id: "high" }] }, "low"),
    "medium",
  );
});
