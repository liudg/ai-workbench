import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ILink } from "@xterm/xterm";

import {
  createFileLinkVerifier,
  createOscLinkHandler,
  createTerminalLinkProvider,
  detectLinksForBufferLine,
  findTerminalLinkAt,
  isLikelyFilePath,
  isLocalOrIntranetUrl,
  isTerminalLinkTrigger,
  parseFileUrlCandidate,
  readWrappedLogicalLine,
  scanTextLinks,
  type TerminalBufferLike,
  type TerminalCellLike,
  type TerminalLineLike,
} from "./terminal-links.ts";

/** 判断码点在终端里是否占 2 列（CJK 表意文字、全角标点等）。 */
function charCellWidth(ch: string): 1 | 2 {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x1f300
  ) {
    return 2;
  }
  return 1;
}

/**
 * 模拟 xterm 缓冲区：按给定的列宽 `cols` 自动软换行（设置 `isWrapped = true`），
 * CJK 等宽字符占 2 格（第 1 格 width=2，第 2 格 width=0, chars=""），完全复刻 xterm 真实布局。
 */
function buildMockBuffer(logicalLines: readonly string[], cols: number): TerminalBufferLike {
  const rows: Array<{ isWrapped: boolean; cells: Array<{ width: number; chars: string }> }> = [];

  for (const logical of logicalLines) {
    let currentCells: Array<{ width: number; chars: string }> = [];
    let wrapped = false;

    const flushRow = () => {
      while (currentCells.length < cols) {
        currentCells.push({ width: 1, chars: "" });
      }
      rows.push({ isWrapped: wrapped, cells: currentCells });
      currentCells = [];
      wrapped = true;
    };

    for (const ch of logical) {
      const w = charCellWidth(ch);
      if (currentCells.length + w > cols) {
        flushRow();
      }
      currentCells.push({ width: w, chars: ch });
      if (w === 2) {
        currentCells.push({ width: 0, chars: "" });
      }
    }
    while (currentCells.length < cols) {
      currentCells.push({ width: 1, chars: "" });
    }
    rows.push({ isWrapped: wrapped, cells: currentCells });
  }

  const lineObjects: TerminalLineLike[] = rows.map((row) => ({
    isWrapped: row.isWrapped,
    length: row.cells.length,
    getCell(x: number): TerminalCellLike | undefined {
      const entry = row.cells[x];
      if (!entry) return undefined;
      return {
        getWidth: () => entry.width,
        getChars: () => entry.chars,
      };
    },
  }));

  return {
    length: lineObjects.length,
    viewportY: 0,
    getLine: (y: number) => lineObjects[y],
  };
}

describe("terminal link detection and routing", () => {
  test("classifies local/intranet vs external public URLs accurately", () => {
    for (const local of [
      "http://localhost:4573",
      "http://localhost:5173/preview?tab=1",
      "https://api.dev.localhost:8443/v1",
      "http://my-devbox.local:3000/",
      "http://127.0.0.1:8080/health",
      "http://127.0.1.1:9000",
      "http://0.0.0.0:5173/",
      "http://[::1]:4573/app",
      "http://10.0.4.12:3000",
      "http://172.16.0.5:8000",
      "http://172.31.255.254:8000",
      "http://192.168.1.100:5173",
    ]) {
      assert.equal(isLocalOrIntranetUrl(local), true, `expected local: ${local}`);
    }

    for (const external of [
      "https://github.com/tauri-apps/tauri",
      "https://example.com:8080/path",
      "https://localhost.evil.com/phish",
      "http://172.15.255.1/",
      "http://172.32.0.1/",
      "http://8.8.8.8/",
      "ftp://localhost/file",
      "javascript:alert(1)",
    ]) {
      assert.equal(isLocalOrIntranetUrl(external), false, `expected external: ${external}`);
    }
  });

  test("parses Rust, TypeScript, colon-suffixed, quoted, PowerShell, file://, and balanced-paren URLs", () => {
    const rust = scanTextLinks("   --> src\\main.rs:12:5");
    assert.equal(rust.length, 1);
    assert.equal(rust[0]?.kind, "file");
    assert.equal(rust[0]?.path, "src\\main.rs");
    assert.equal(rust[0]?.line, 12);
    assert.equal(rust[0]?.column, 5);
    assert.equal(rust[0]?.text, "src\\main.rs:12:5");

    const ts = scanTextLinks("src/app.ts(12,5): error TS2322: Type 'string' is not assignable.");
    assert.equal(ts.length, 1);
    assert.equal(ts[0]?.path, "src/app.ts");
    assert.equal(ts[0]?.line, 12);
    assert.equal(ts[0]?.column, 5);
    assert.equal(ts[0]?.text, "src/app.ts(12,5)");

    const eslint = scanTextLinks("  src/foo.ts:12:5: Unexpected any");
    assert.equal(eslint.length, 1);
    assert.equal(eslint[0]?.path, "src/foo.ts");
    assert.equal(eslint[0]?.line, 12);
    assert.equal(eslint[0]?.column, 5);
    assert.equal(eslint[0]?.text, "src/foo.ts:12:5");

    const quoted = scanTextLinks('Opening "G:\\My Project\\src\\view main.tsx:48:9" failed.');
    assert.equal(quoted.length, 1);
    assert.equal(quoted[0]?.path, "G:\\My Project\\src\\view main.tsx");
    assert.equal(quoted[0]?.line, 48);
    assert.equal(quoted[0]?.column, 9);
    assert.equal(quoted[0]?.text, "G:\\My Project\\src\\view main.tsx:48:9");

    const ps = scanTextLinks("PS G:\\document\\ai-workbench> cargo test crates/aiwb-daemon/src/main.rs:30");
    assert.equal(ps.length, 1);
    assert.equal(ps[0]?.path, "crates/aiwb-daemon/src/main.rs");
    assert.equal(ps[0]?.line, 30);

    const fileUri = scanTextLinks("at async (file:///G:/document/ai%20workbench/src/index.ts:19:7)");
    assert.equal(fileUri.length, 1);
    assert.equal(fileUri[0]?.path, "G:/document/ai workbench/src/index.ts");
    assert.equal(fileUri[0]?.line, 19);
    assert.equal(fileUri[0]?.column, 7);

    const urls = scanTextLinks(
      "Local (http://localhost:4573/preview), wiki (https://en.wikipedia.org/wiki/Rust_(programming_language)).",
    );
    assert.equal(urls.length, 2);
    assert.equal(urls[0]?.url, "http://localhost:4573/preview");
    assert.equal(urls[0]?.local, true);
    assert.equal(urls[1]?.url, "https://en.wikipedia.org/wiki/Rust_(programming_language)");
    assert.equal(urls[1]?.local, false);
  });

  test("joins soft-wrapped lines backward and forward via isWrapped for both paths and URLs", () => {
    const cols = 30;
    const longPathLine = "  --> crates/aiwb-daemon/src/services/files.rs:94:12";
    const longUrlLine = "Preview ready at http://127.0.0.1:4573/workspace/session?id=abc123";
    const buffer = buildMockBuffer([longPathLine, longUrlLine], cols);

    // longPathLine 长度 52，在 30 列终端里软换行成物理第 1、2 行
    const fromRow1 = detectLinksForBufferLine(buffer, cols, 1);
    const fromRow2 = detectLinksForBufferLine(buffer, cols, 2);
    assert.equal(fromRow1.length, 1);
    assert.deepEqual(fromRow1, fromRow2);
    assert.equal(fromRow1[0]?.kind, "file");
    if (fromRow1[0]?.kind === "file") {
      assert.equal(fromRow1[0].path, "crates/aiwb-daemon/src/services/files.rs");
      assert.equal(fromRow1[0].line, 94);
      assert.equal(fromRow1[0].column, 12);
    }
    assert.deepEqual(fromRow1[0]?.range, {
      start: { x: 7, y: 1 },
      end: { x: 22, y: 2 },
    });

    // longUrlLine 占物理第 3、4、5 行，悬浮在中间第 4 行或末尾第 5 行都能拼出完整 URL
    const urlFromRow4 = detectLinksForBufferLine(buffer, cols, 4);
    const urlFromRow5 = detectLinksForBufferLine(buffer, cols, 5);
    assert.equal(urlFromRow4.length, 1);
    assert.deepEqual(urlFromRow4, urlFromRow5);
    if (urlFromRow4[0]?.kind === "url") {
      assert.equal(urlFromRow4[0].url, "http://127.0.0.1:4573/workspace/session?id=abc123");
      assert.equal(urlFromRow4[0].local, true);
    }
    assert.deepEqual(urlFromRow4[0]?.range, {
      start: { x: 18, y: 3 },
      end: { x: 6, y: 5 },
    });
  });

  test("maps CJK wide characters (width=2) accurately to 1-based IBufferRange cell columns", () => {
    // "错误位置 " -> 4 个汉字（8 列）+ 1 个空格（1 列）= 共 9 列，因此 `src/main.rs:12:5` 从第 10 列开始！
    const buffer = buildMockBuffer(["错误位置 src/main.rs:12:5 请检查"], 80);
    const links = detectLinksForBufferLine(buffer, 80, 1);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.kind, "file");
    assert.deepEqual(links[0]?.range, {
      start: { x: 10, y: 1 },
      end: { x: 25, y: 1 },
    });

    // 右键命中测试：第 9 列是空格，第 10..25 列命中该文件链接，第 26 列是空格
    assert.equal(findTerminalLinkAt(buffer, 80, 1, 9), null);
    assert.equal(findTerminalLinkAt(buffer, 80, 1, 10)?.text, "src/main.rs:12:5");
    assert.equal(findTerminalLinkAt(buffer, 80, 1, 25)?.text, "src/main.rs:12:5");
    assert.equal(findTerminalLinkAt(buffer, 80, 1, 26), null);

    // 路径本身包含汉字：`docs/说明.md:8` -> `d`(1) `o`(2) `c`(3) `s`(4) `/`(5) `说`(6-7) `明`(8-9) `.`(10) `m`(11) `d`(12) `:`(13) `8`(14)
    const cjkPathBuf = buildMockBuffer(["docs/说明.md:8"], 80);
    const cjkLinks = detectLinksForBufferLine(cjkPathBuf, 80, 1);
    assert.equal(cjkLinks.length, 1);
    if (cjkLinks[0]?.kind === "file") {
      assert.equal(cjkLinks[0].path, "docs/说明.md");
      assert.equal(cjkLinks[0].line, 8);
    }
    assert.deepEqual(cjkLinks[0]?.range, {
      start: { x: 1, y: 1 },
      end: { x: 14, y: 1 },
    });
  });

  test("resolves soft-wrapped CJK file paths and URLs cleanly without turning wide-char autowrap padding into a fake space", () => {
    // `cols = 6`: `docs/` occupies cols 1..5, col 6 gets width=1 empty autowrap padding because `说` has width=2!
    const wrappedBeforeFirstCjk = buildMockBuffer(["docs/说明.md:8"], 6);
    const logical6 = readWrappedLogicalLine(wrappedBeforeFirstCjk, 6, 1);
    assert.equal(logical6?.text, "docs/说明.md:8");
    const links6 = detectLinksForBufferLine(wrappedBeforeFirstCjk, 6, 1);
    assert.equal(links6.length, 1);
    assert.equal(links6[0]?.kind, "file");
    if (links6[0]?.kind === "file") {
      assert.equal(links6[0].path, "docs/说明.md");
      assert.equal(links6[0].line, 8);
    }

    // `cols = 8`: `docs/说` occupies cols 1..7 (col 6..7 is `说`), col 8 gets width=1 empty autowrap padding before `明`!
    const wrappedBetweenCjk = buildMockBuffer(["docs/说明.md:8"], 8);
    const logical8 = readWrappedLogicalLine(wrappedBetweenCjk, 8, 2);
    assert.equal(logical8?.text, "docs/说明.md:8");
    const links8 = detectLinksForBufferLine(wrappedBetweenCjk, 8, 2);
    assert.equal(links8.length, 1);
    if (links8[0]?.kind === "file") {
      assert.equal(links8[0].path, "docs/说明.md");
      assert.equal(links8[0].line, 8);
    }

    // Soft-wrapped URL with CJK path segment wrapped right before wide char (`http://localhost:4573/` = 22 cols, cols = 23)
    const wrappedCjkUrl = buildMockBuffer(["http://localhost:4573/说明文档"], 23);
    const urlLinks = detectLinksForBufferLine(wrappedCjkUrl, 23, 1);
    assert.equal(urlLinks.length, 1);
    assert.equal(urlLinks[0]?.kind, "url");
    if (urlLinks[0]?.kind === "url") {
      assert.equal(urlLinks[0].url, "http://localhost:4573/说明文档");
      assert.equal(urlLinks[0].local, true);
    }
  });

  test("enforces Ctrl+Click on Windows/Linux and Cmd+Click on macOS", () => {
    assert.equal(isTerminalLinkTrigger({ button: 0, ctrlKey: false, metaKey: false, altKey: false }, false), false);
    assert.equal(isTerminalLinkTrigger({ button: 0, ctrlKey: true, metaKey: false, altKey: false }, false), true);
    assert.equal(isTerminalLinkTrigger({ button: 0, ctrlKey: false, metaKey: true, altKey: false }, false), false);
    assert.equal(isTerminalLinkTrigger({ button: 2, ctrlKey: true, metaKey: false, altKey: false }, false), false);

    assert.equal(isTerminalLinkTrigger({ button: 0, ctrlKey: false, metaKey: true, altKey: false }, true), true);
    assert.equal(isTerminalLinkTrigger({ button: 0, ctrlKey: true, metaKey: false, altKey: false }, true), false);
  });

  test("debounces hover file existence check and routes local URLs, external URLs, and verified files", async () => {
    const resolvedCalls: string[] = [];
    const disk = new Map<string, string>([["src/main.rs", "G:/document/ai-workbench/src/main.rs"]]);
    const verifier = createFileLinkVerifier(
      async (path) => {
        resolvedCalls.push(path);
        return disk.get(path) ?? null;
      },
      { hoverDelayMs: 30 },
    );

    const openedLocal: string[] = [];
    const openedExternal: string[] = [];
    const openedFiles: Array<{ path: string; line: number | null }> = [];

    const buffer = buildMockBuffer(
      ["src/main.rs:12:5 missing/ghost.rs:3 http://localhost:4573 https://example.com/docs"],
      120,
    );
    const provider = createTerminalLinkProvider(
      () => ({ buffer, cols: 120 }),
      verifier,
      {
        openLocalUrl: (url) => openedLocal.push(url),
        openExternalUrl: (url) => openedExternal.push(url),
        openFile: (path, line) => openedFiles.push({ path, line }),
        isMac: false,
      },
    );

    let provided: ILink[] | undefined;
    provider.provideLinks(1, (links) => {
      provided = links;
    });
    assert.ok(provided);
    assert.equal(provided.length, 4);

    const [localLink, externalLink, validFileLink, missingFileLink] = [
      provided.find((l) => l.text.startsWith("http://localhost"))!,
      provided.find((l) => l.text.startsWith("https://example.com"))!,
      provided.find((l) => l.text.startsWith("src/main.rs"))!,
      provided.find((l) => l.text.startsWith("missing/ghost.rs"))!,
    ];

    // URL 默认直接可点，而未校验的文件候选初始不显示下划线和手型指针
    assert.deepEqual(localLink.decorations, { pointerCursor: true, underline: true });
    assert.deepEqual(validFileLink.decorations, { pointerCursor: false, underline: false });

    // 快速掠过（未满防抖时间即移开）：不请求 daemon
    validFileLink.hover?.({} as MouseEvent, validFileLink.text);
    validFileLink.leave?.({} as MouseEvent, validFileLink.text);
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(resolvedCalls.length, 0);
    assert.deepEqual(validFileLink.decorations, { pointerCursor: false, underline: false });

    // 停留超过防抖时间：真实存在的文件点亮下划线与指针，不存在的文件保持关闭
    validFileLink.hover?.({} as MouseEvent, validFileLink.text);
    missingFileLink.hover?.({} as MouseEvent, missingFileLink.text);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(resolvedCalls, ["src/main.rs", "missing/ghost.rs"]);
    assert.deepEqual(validFileLink.decorations, { pointerCursor: true, underline: true });
    assert.deepEqual(missingFileLink.decorations, { pointerCursor: false, underline: false });

    // 普通单击不跳转；Ctrl+Click 触发正确路由
    localLink.activate({ button: 0, ctrlKey: false, metaKey: false, altKey: false } as MouseEvent, localLink.text);
    validFileLink.activate({ button: 0, ctrlKey: false, metaKey: false, altKey: false } as MouseEvent, validFileLink.text);
    assert.equal(openedLocal.length, 0);
    assert.equal(openedFiles.length, 0);

    const ctrlClick = { button: 0, ctrlKey: true, metaKey: false, altKey: false } as MouseEvent;
    localLink.activate(ctrlClick, localLink.text);
    externalLink.activate(ctrlClick, externalLink.text);
    validFileLink.activate(ctrlClick, validFileLink.text);
    missingFileLink.activate(ctrlClick, missingFileLink.text);
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(openedLocal, ["http://localhost:4573"]);
    assert.deepEqual(openedExternal, ["https://example.com/docs"]);
    assert.deepEqual(openedFiles, [
      { path: "G:/document/ai-workbench/src/main.rs", line: 12 as number | null },
    ]);
    // 命中缓存，不重复发起 RPC
    assert.equal(resolvedCalls.length, 2);

    // OSC 8 同样支持 file:// 与安全协议校验
    const osc = createOscLinkHandler(verifier, {
      openLocalUrl: (url) => openedLocal.push(url),
      openExternalUrl: (url) => openedExternal.push(url),
      openFile: (path, line) => openedFiles.push({ path, line }),
      isMac: false,
    });
    disk.set("G:/document/ai-workbench/src/main.rs", "G:/document/ai-workbench/src/main.rs");
    osc.activate(ctrlClick, "javascript:alert(1)");
    osc.activate(ctrlClick, "file:///G:/document/ai-workbench/src/main.rs#L42");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(openedFiles.length, 2);
    assert.deepEqual(openedFiles[1], { path: "G:/document/ai-workbench/src/main.rs", line: 42 });
  });

  test("preserves cursor-forward blank cells on soft-wrapped rows while skipping width=0 wide-char spacers", () => {
    const cols = 16;
    // Row 0 (length 16) has "error at" in cols 0..7, 7 cursor-forward blank cells (width=1, chars="") in cols 8..14,
    // and 1 wide-char wrap spacer (width=0, chars="") at col 15, followed by soft-wrapped Row 1 ("src/main.rs:9:1").
    const row0Cells = [
      ..."error at".split("").map((ch) => ({ width: 1, chars: ch })),
      ...Array.from({ length: 7 }, () => ({ width: 1, chars: "" })),
      { width: 0, chars: "" },
    ];
    const row1Cells = [
      ..."src/main.rs:9:1".split("").map((ch) => ({ width: 1, chars: ch })),
      { width: 1, chars: "" },
    ];
    const rows = [
      { isWrapped: false, cells: row0Cells },
      { isWrapped: true, cells: row1Cells },
    ];
    const buffer: TerminalBufferLike = {
      length: rows.length,
      viewportY: 0,
      getLine: (y) => {
        const r = rows[y];
        if (!r) return undefined;
        return {
          isWrapped: r.isWrapped,
          length: r.cells.length,
          getCell: (x) => {
            const c = r.cells[x];
            return c ? { getWidth: () => c.width, getChars: () => c.chars } : undefined;
          },
        };
      },
    };

    const logical = readWrappedLogicalLine(buffer, cols, 1);
    assert.equal(logical?.text, `error at${" ".repeat(7)}src/main.rs:9:1`);
    const links = detectLinksForBufferLine(buffer, cols, 2);
    assert.equal(links.length, 1);
    if (links[0]?.kind === "file") {
      assert.equal(links[0].path, "src/main.rs");
      assert.equal(links[0].line, 9);
      assert.equal(links[0].column, 1);
    }
  });

  test("preserves Windows UNC file:// URLs and accepts /C:/... stack-trace paths", () => {
    const uncParsed = parseFileUrlCandidate("file://server/share/dir/a.ts:15:3");
    assert.deepEqual(uncParsed, {
      path: "\\\\server\\share\\dir\\a.ts",
      line: 15,
      column: 3,
    });
    const uncFourSlash = parseFileUrlCandidate("file:////server/share/dir/b.ts#L20");
    assert.deepEqual(uncFourSlash, {
      path: "\\\\server\\share\\dir\\b.ts",
      line: 20,
      column: null,
    });

    const scannedUnc = scanTextLinks("at file://server/share/dir/a.ts:15:3");
    assert.equal(scannedUnc.length, 1);
    assert.equal(scannedUnc[0]?.path, "\\\\server\\share\\dir\\a.ts");
    assert.equal(scannedUnc[0]?.line, 15);

    assert.equal(isLikelyFilePath("/C:/Users/dev/app.ts", false), true);
    const slashDrive = scanTextLinks("  at /G:/document/ai-workbench/src/app.tsx:44:9");
    assert.equal(slashDrive.length, 1);
    assert.equal(slashDrive[0]?.path, "/G:/document/ai-workbench/src/app.tsx");
    assert.equal(slashDrive[0]?.line, 44);
    assert.equal(slashDrive[0]?.column, 9);
  });
});
