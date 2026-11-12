import { useState } from "react";

import { GitBranchChrome, WorkContextPicker } from "@/features/chat";

const PROJECTS = [
  { id: "csgo", name: "CSGO" },
  { id: "notes", name: "笔记" },
];

/**
 * 开发预览。`?preview=git-branch`，`scene=closed|menu|create`，`fail=checkout` 模拟切换失败。
 */
export default function GitBranchPreview() {
  const params = new URLSearchParams(window.location.search);
  const scene = params.get("scene") ?? "closed";
  const failCheckout = params.get("fail") === "checkout";
  const [current, setCurrent] = useState("master");
  const [branches, setBranches] = useState(["master", "topic", "feature/next"]);

  return (
    <div className="flex min-h-screen items-end justify-center bg-wb-surface px-6 pb-24 text-wb-fg">
      <div className="w-full max-w-[760px]">
        <div className="min-w-0 rounded-2xl border border-wb-border-strong bg-wb-composer shadow-[var(--wb-composer-shadow)]">
          <div className="flex min-w-0 items-center gap-2 border-b border-wb-border px-2.5 py-1.5">
            <WorkContextPicker
              label="CSGO"
              projects={PROJECTS}
              selectedId="csgo"
              standaloneId="chat"
              canRetarget={false}
              onPickProject={() => {}}
              onPickStandalone={() => {}}
            />
            <GitBranchChrome
              label={current}
              projectName="CSGO"
              current={current}
              branches={branches}
              dirtyFiles={135}
              listError={null}
              initialOpen={scene === "menu" || scene === "create"}
              initialCreate={scene === "create"}
              onCheckout={async (name) => {
                if (failCheckout) throw new Error("有未提交的改动，无法切换分支");
                setCurrent(name);
              }}
              onCreate={async (name) => {
                const trimmed = name.trim();
                if (branches.includes(trimmed)) throw new Error("分支已存在");
                setBranches((items) => [trimmed, ...items.filter((item) => item !== trimmed)]);
                setCurrent(trimmed);
              }}
            />
          </div>
          <p className="px-3.5 pt-3 pb-8 text-sm text-wb-fg-3">输入任务或问题，@ 引用文件</p>
        </div>
      </div>
    </div>
  );
}
