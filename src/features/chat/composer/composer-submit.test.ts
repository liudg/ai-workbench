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
  goalDraft: false,
  supportsGoals: true,
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
  assert.deepEqual(decideSubmit({ ...base, text: "补齐回归", goalDraft: true }), {
    type: "set-goal",
    text: "补齐回归",
  });
  assert.deepEqual(decideSubmit({ ...base, text: "/plan", goalDraft: true }).type, "toggle-plan");
  assert.equal(decideSubmit({ ...base, text: "补齐回归", goalDraft: true, supportsGoals: false }).type, "send-images");
  assert.equal(
    decideSubmit({ ...base, text: "改一下", goalDraft: true, editingId: "q1" }).type,
    "update-queue",
  );
  assert.equal(
    decideSubmit({ ...base, text: "补齐回归", goalDraft: true, composerLocked: true }).type,
    "noop",
  );
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
  assert.deepEqual(
    decideSubmit({
      ...base,
      imagesOn: false,
      text: "先排队",
      pendingId: "p1",
      pendingKind: "approval",
    }),
    { type: "send-text", text: "先排队", clearAttachments: true },
  );
  assert.equal(decideSubmit({ ...base, text: "好", pendingId: "p1", composerLocked: true }).type, "noop");
  assert.deepEqual(
    decideSubmit({ ...base, text: "", attached: [{ name: "a.png", path: "C:/a.png" }] }),
    { type: "send-images", text: "", images: ["C:/a.png"] },
  );
  assert.equal(decideSubmit({ ...base, text: "  \n\t" }).type, "noop");
  assert.deepEqual(
    decideSubmit({ ...base, text: "  \n", attached: [{ name: "a.png", path: "C:/a.png" }] }),
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

const quote = "```12:14:Assets/Editor/Preview.cs\npublic void Open()\n```";

test("selected text stays out of the box until submit, and a removed snippet is not sent", () => {
  const snippets = [{ quote }, { quote: "```a.cs\nsecond\n```" }];
  assert.deepEqual(decideSubmit({ ...base, text: "", snippets: [snippets[0]] }), {
    type: "send-images",
    text: quote,
    images: [],
    clearSnippets: true,
  });
  assert.deepEqual(decideSubmit({ ...base, imagesOn: false, text: "先看这个", snippets }), {
    type: "send-text",
    text: `先看这个\n\n${quote}\n\n\`\`\`a.cs\nsecond\n\`\`\``,
    clearAttachments: true,
    clearSnippets: true,
  });
  assert.deepEqual(
    decideSubmit({
      ...base,
      text: "看这个",
      snippets: [snippets[0]],
      attached: [
        { name: "a.png", path: "C:/a.png" },
        { name: "notes.txt", path: "C:/work/notes.txt" },
      ],
    }),
    {
      type: "send-images",
      text: `看这个\n\n${quote}\n\n附件：C:/work/notes.txt`,
      images: ["C:/a.png"],
      clearSnippets: true,
    },
  );
  assert.deepEqual(decideSubmit({ ...base, imagesOn: false, text: "/help", snippets }), {
    type: "send-text",
    text: "/help",
    clearAttachments: false,
  });
  assert.deepEqual(
    decideSubmit({ ...base, text: "改一下", editingId: "q1", snippets: [snippets[0]] }),
    { type: "update-queue", id: "q1", text: `改一下\n\n${quote}`, images: [], clearSnippets: true },
  );
  assert.deepEqual(decideSubmit({ ...base, text: "  ", editingId: "q1", snippets: [snippets[0]] }), {
    type: "update-queue",
    id: "q1",
    text: quote,
    images: [],
    clearSnippets: true,
  });
  assert.deepEqual(decideSubmit({ ...base, text: "/help", editingId: "q1", snippets: [snippets[0]] }), {
    type: "update-queue",
    id: "q1",
    text: "/help",
    images: [],
  });
  assert.deepEqual(decideSubmit({ ...base, text: "好", pendingId: "p1", snippets: [snippets[0]] }), {
    type: "answer",
    promptId: "p1",
    text: `好\n\n${quote}`,
    clearSnippets: true,
  });
  assert.deepEqual(decideSubmit({ ...base, text: "/plan 先看结构", snippets: [snippets[0]] }), {
    type: "plan-message",
    text: `先看结构\n\n${quote}`,
    clearSnippets: true,
  });
  assert.deepEqual(decideSubmit({ ...base, text: "补齐回归", goalDraft: true, snippets }), {
    type: "set-goal",
    text: "补齐回归",
  });
  assert.equal(decideSubmit({ ...base, text: "", snippets, composerLocked: true }).type, "noop");
  assert.deepEqual(
    decideSubmit({ ...base, imagesOn: false, text: "先看这个", snippets: [snippets[1]] }),
    {
      type: "send-text",
      text: "先看这个\n\n```a.cs\nsecond\n```",
      clearAttachments: true,
      clearSnippets: true,
    },
  );
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
