import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";

const dom = new Window({ url: "http://localhost/" });
const globals = {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  SVGElement: dom.SVGElement,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
const descriptors = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const clipboard: string[] = [];
Object.defineProperty(dom.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      clipboard.push(text);
    },
  },
});

let server: ViteDevServer;
let DiffToolbar: typeof import("./DiffToolbar.tsx").DiffToolbar;
let isGitWorkingTreeScope: typeof import("./toolbar-actions.ts").isGitWorkingTreeScope;
let errorBanner: typeof import("../../../shared/shell/error-banner.ts");

before(async () => {
  const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
  server = await createServer({
    root: rootDir,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
  });
  DiffToolbar = (await server.ssrLoadModule("/src/features/panel/diff/DiffToolbar.tsx")).DiffToolbar;
  isGitWorkingTreeScope = (await server.ssrLoadModule("/src/features/panel/diff/toolbar-actions.ts"))
    .isGitWorkingTreeScope;
  errorBanner = (await server.ssrLoadModule(
    "/src/shared/shell/error-banner.ts",
  )) as typeof errorBanner;
});

after(async () => {
  await server?.close();
  await dom.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const SCOPES = [
  { id: "turn", label: "上一轮", source: "turn" },
  { id: "uncommitted", label: "未提交", source: "git" },
  { id: "staged", label: "已暂存", source: "git" },
  { id: "unstaged", label: "未暂存", source: "git" },
];

function toolbarProps(
  scope: string,
  onGenerateCommitMessage?: (() => Promise<string>) | null,
) {
  return {
    scope,
    scopes: SCOPES,
    onScope: () => {},
    added: 8,
    removed: 2,
    expanded: true,
    onToggleExpanded: () => {},
    layoutSplit: false,
    onToggleLayout: () => {},
    wrap: true,
    onToggleWrap: () => {},
    onRefresh: () => {},
    loadFull: false,
    onToggleLoadFull: () => {},
    renderPreview: false,
    onToggleRenderPreview: () => {},
    wordDiff: true,
    onToggleWordDiff: () => {},
    hideWs: false,
    onToggleHideWs: () => {},
    hideImports: false,
    onToggleHideImports: () => {},
    filesOpen: true,
    onToggleFiles: () => {},
    jumpFiles: [],
    activePath: "",
    onJump: () => {},
    copyCommand: null,
    copyReason: "",
    onGenerateCommitMessage,
  };
}

test("isGitWorkingTreeScope distinguishes working-tree git scopes from static turn patches", () => {
  assert.equal(isGitWorkingTreeScope("turn", []), false);
  assert.equal(isGitWorkingTreeScope("turn", SCOPES), false);
  assert.equal(isGitWorkingTreeScope("uncommitted", SCOPES), true);
  assert.equal(isGitWorkingTreeScope("staged", SCOPES), true);
  assert.equal(isGitWorkingTreeScope("unstaged", SCOPES), true);
});

test("DiffToolbar shows AI commit message button only on Git scopes, copies message to clipboard, and reports errors", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  clipboard.length = 0;
  errorBanner.clearError();

  function BannerReader() {
    return createElement("output", { "data-error-banner": "" }, errorBanner.useErrorBanner() ?? "");
  }

  try {
    // 1. Historical turn scope -> button hidden even if callback passed
    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(DiffToolbar, toolbarProps("turn", async () => "feat: x")),
          createElement(BannerReader),
        ),
      );
    });
    assert.equal(host.querySelector("[data-diff-commit-gen]"), null);

    // 2. Git uncommitted scope -> button shown; clicking copies commit message and shows feedback
    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(
            DiffToolbar,
            toolbarProps("uncommitted", async () => "feat(rewind): 支持对话与工作区双模回退\n\n- 还原草稿与附件"),
          ),
          createElement(BannerReader),
        ),
      );
    });
    const btn = host.querySelector("[data-diff-commit-gen]") as unknown as HTMLButtonElement;
    assert.ok(btn);
    assert.match(btn.textContent ?? "", /AI 生成提交说明/);

    await act(async () => btn.click());
    assert.deepEqual(clipboard, ["feat(rewind): 支持对话与工作区双模回退\n\n- 还原草稿与附件"]);
    assert.match(btn.textContent ?? "", /已复制提交说明/);
    assert.equal(host.querySelector("[data-error-banner]")?.textContent, "");

    // 3. Empty/error response -> shows error via showError
    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(
            DiffToolbar,
            toolbarProps("staged", async () => {
              throw new Error("未检测到可用的轻量生成模型");
            }),
          ),
          createElement(BannerReader),
        ),
      );
    });
    const stagedBtn = host.querySelector("[data-diff-commit-gen]") as unknown as HTMLButtonElement;
    await act(async () => stagedBtn.click());
    assert.equal(host.querySelector("[data-error-banner]")?.textContent, "未检测到可用的轻量生成模型");

    // 4. Scope change or unmount while awaiting generation must NOT write stale message to clipboard
    clipboard.length = 0;
    let resolveInFlight: ((msg: string) => void) | null = null;
    await act(async () => {
      root.render(
        createElement(
          DiffToolbar,
          toolbarProps(
            "uncommitted",
            () =>
              new Promise<string>((resolve) => {
                resolveInFlight = resolve;
              }),
          ),
        ),
      );
    });
    await act(async () => {
      (host.querySelector("[data-diff-commit-gen]") as unknown as HTMLButtonElement).click();
    });
    assert.ok(resolveInFlight);

    // Switch scope to "staged" before in-flight generation resolves
    await act(async () => {
      root.render(createElement(DiffToolbar, toolbarProps("staged", async () => "feat: staged")));
    });
    await act(async () => {
      resolveInFlight?.("feat: stale uncommitted message");
    });
    assert.deepEqual(clipboard, [], "stale scope generation must not overwrite clipboard");
  } finally {
    await act(async () => root.unmount());
    errorBanner.clearError();
    host.remove();
  }
});
