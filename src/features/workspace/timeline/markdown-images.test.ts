import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMessageContent } from "./markdown-images.ts";

const SCREENSHOT =
  "第五个开箱效果预览：\n![开箱效果](F:/mercury_resource/client/mercury_dev/Temp/HuoyueLayout/header-opened-preview.png)";

test("renders the screenshot local windows path as an image", () => {
  const parts = parseMessageContent(SCREENSHOT);
  assert.deepEqual(parts, [
    { type: "text", text: "第五个开箱效果预览：\n" },
    {
      type: "image",
      alt: "开箱效果",
      source: {
        type: "local",
        path: "F:\\mercury_resource\\client\\mercury_dev\\Temp\\HuoyueLayout\\header-opened-preview.png",
      },
    },
  ]);
});

test("renders https images and keeps surrounding text", () => {
  const parts = parseMessageContent(
    "看这里 ![star](https://cdn.example.com/a.png?sig=1) 结束",
  );
  assert.deepEqual(parts, [
    { type: "text", text: "看这里 " },
    {
      type: "image",
      alt: "star",
      source: { type: "https", url: "https://cdn.example.com/a.png?sig=1" },
    },
    { type: "text", text: " 结束" },
  ]);
});

test("accepts titles, angle brackets, spaces, and balanced parentheses", () => {
  const titled = parseMessageContent(
    '![a](https://cdn.example.com/a.png "预览")',
  );
  assert.equal(titled[0].type, "image");

  const spaced = parseMessageContent("![a](<F:/my folder/shot.png>)");
  assert.deepEqual(spaced[0], {
    type: "image",
    alt: "a",
    source: { type: "local", path: "F:\\my folder\\shot.png" },
  });

  const parens = parseMessageContent(
    "![a](F:/Program Files (x86)/shot.png)",
  );
  assert.deepEqual(parens[0], {
    type: "image",
    alt: "a",
    source: { type: "local", path: "F:\\Program Files (x86)\\shot.png" },
  });
});

test("accepts backslashes, file urls, and UNC paths", () => {
  const slashed = parseMessageContent("![a](C:\\Temp\\shot.jpeg)");
  assert.deepEqual(slashed[0], {
    type: "image",
    alt: "a",
    source: { type: "local", path: "C:\\Temp\\shot.jpeg" },
  });

  const fileUrl = parseMessageContent(
    "![a](file:///F:/Temp/my%20shot.webp)",
  );
  assert.deepEqual(fileUrl[0], {
    type: "image",
    alt: "a",
    source: { type: "local", path: "F:\\Temp\\my shot.webp" },
  });

  const unc = parseMessageContent("![a](\\\\files\\share\\shot.gif)");
  assert.deepEqual(unc[0], {
    type: "image",
    alt: "a",
    source: { type: "local", path: "\\\\files\\share\\shot.gif" },
  });
});

test("leaves unsafe or non-image targets as text", () => {
  const samples = [
    "![x](javascript:alert(1))",
    "![x](http://cdn.example.com/a.png)",
    "![x](data:image/png;base64,aaaa)",
    "![x](F:/secret/notes.txt)",
    "![x](F:/secret/../../Windows/system.ini)",
    "![x](notes.png)",
    "![x](https://user:pass@cdn.example.com/a.png)",
  ];
  for (const sample of samples) {
    assert.deepEqual(parseMessageContent(sample), [{ type: "text", text: sample }]);
  }
});

test("does not render images inside fenced or inline code", () => {
  const fenced = "```\n![a](https://cdn.example.com/a.png)\n```\n之后 ![b](https://cdn.example.com/b.png)";
  const parts = parseMessageContent(fenced);
  assert.equal(parts[0].type, "text");
  if (parts[0].type === "text") {
    assert.match(parts[0].text, /!\[a\]/);
  }
  assert.equal(parts[1].type, "image");

  const inline = "代码 `![a](https://cdn.example.com/a.png)` 结束";
  assert.deepEqual(parseMessageContent(inline), [{ type: "text", text: inline }]);
});
