import { useState } from "react";

import { GitBranchChrome } from "@/features/chat/composer/GitBranchControl";
import { WorkContextPicker } from "@/features/chat/composer/WorkContextPicker";

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
    <div className="flex min-h-screen items-end justify-center bg-[#0f0f0f] px-6 pb-24 text-[#e8e8e8]">
      <div className="w-full max-w-[760px]">
        <div className="mb-2 flex min-w-0 items-center gap-2 px-1">
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
        <div className="min-w-0 rounded-[18px] border border-[#2a2a2a] bg-[#171717] px-3 pt-3 pb-2.5">
          <p className="px-1 pb-8 text-sm text-zinc-500">随心输入</p>
        </div>
      </div>
    </div>
  );
}
