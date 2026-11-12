import { useEffect, useMemo, useRef } from "react";

import { AnswerMarkdownHost } from "@/features/chat";
import { parseUnifiedDiff, type FileChange } from "@/features/changes-model";
import { SessionSplit, usePanel } from "@/features/panel";
import { ProjectPanel } from "@/features/workspace";
import type { SessionEvent } from "@/types";

const INSPECT = [
  "diff --git a/Library/GemFeedback/inspect_prefab.cs b/Library/GemFeedback/inspect_prefab.cs",
  "index 1111111..2222222 100644",
  "--- a/Library/GemFeedback/inspect_prefab.cs",
  "+++ b/Library/GemFeedback/inspect_prefab.cs",
  "@@ -1,4 +1,5 @@",
  " using UnityEngine;",
  "+using UnityEngine.UI;",
  " public class InspectPrefab",
  " {",
  "     void Run()",
  "@@ -12,3 +13,3 @@",
  "     }",
  '-    string label = "old value";',
  '+    string label = "new value and a very long token that should wrap when automatic wrapping is enabled so this line cannot stay on one row";',
  " }",
].join("\n");

const INVOKE = [
  "diff --git a/Library/GemFeedback/invoke.ps1 b/Library/GemFeedback/invoke.ps1",
  "index aaaaaaa..bbbbbbb 100644",
  "--- a/Library/GemFeedback/invoke.ps1",
  "+++ b/Library/GemFeedback/invoke.ps1",
  "@@ -1,3 +1,3 @@",
  " Write-Host start",
  "-Write-Host old",
  "+Write-Host new",
  " Write-Host end",
].join("\n");

const BAOSHI = [
  "diff --git a/Scripts/GameUI/Module/PlayerEquipmentBaoshi.cs b/Scripts/GameUI/Module/PlayerEquipmentBaoshi.cs",
  "index ccccccc..ddddddd 100644",
  "--- a/Scripts/GameUI/Module/PlayerEquipmentBaoshi.cs",
  "+++ b/Scripts/GameUI/Module/PlayerEquipmentBaoshi.cs",
  "@@ -4,2 +4,3 @@",
  " public class PlayerEquipmentBaoshi {",
  "+    public int slot = 2;",
  " }",
].join("\n");

const SPACING = [
  "diff --git a/Library/GemFeedback/spacing.txt b/Library/GemFeedback/spacing.txt",
  "--- a/Library/GemFeedback/spacing.txt",
  "+++ b/Library/GemFeedback/spacing.txt",
  "@@ -1 +1 @@",
  "-a b",
  "+a  b",
].join("\n");

const ADDED = [
  "using UnityEngine;",
  "",
  "public class AdjustPrefab",
  "{",
  "    public int level;",
  "    void Apply()",
  "    {",
  "        level += 1;",
  "    }",
  "}",
].join("\n");

const REMOVED = ["public class OldPrefab", "{", "    void Gone() {}", "}"].join("\n");

const NOTE = [
  "diff --git a/Library/GemFeedback/note.md b/Library/GemFeedback/note.md",
  "--- a/Library/GemFeedback/note.md",
  "+++ b/Library/GemFeedback/note.md",
  "@@ -1 +1,2 @@",
  "-old note",
  "+# 反馈",
  "+预览这一段",
].join("\n");

const FILES: FileChange[] = [
  { path: "Temp/HomeBuildingUpgrade/AdjustPrefab.cs", status: "A", added: 10, removed: 0, diff: ADDED },
  { path: "Temp/HomeBuildingUpgrade/OldPrefab.cs", status: "D", added: 0, removed: 4, diff: REMOVED },
  { path: "Library/GemFeedback/inspect_prefab.cs", status: "M", added: 2, removed: 1, diff: INSPECT },
  { path: "Library/GemFeedback/invoke.ps1", status: "M", added: 1, removed: 1, diff: INVOKE },
  { path: "Scripts/GameUI/Module/PlayerEquipmentBaoshi.cs", status: "M", added: 1, removed: 0, diff: BAOSHI },
  { path: "Library/GemFeedback/spacing.txt", status: "M", added: 1, removed: 1, diff: SPACING },
  { path: "Library/GemFeedback/note.md", status: "M", added: 2, removed: 1, diff: NOTE },
];

const PREVIEW_DIFF_KEY = "ai-workbench.preview-diff";

/** 开发预览可塞进一份真实 `git diff` 文本。没有就用上面的样例。 */
function previewFiles(): FileChange[] {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("diff") || window.sessionStorage.getItem(PREVIEW_DIFF_KEY) || "";
  if (!raw.trim()) return FILES;
  const parsed = parseUnifiedDiff(raw);
  return parsed.length > 0 ? parsed : FILES;
}

/** 开发预览：挂上真实差异视图，方便在没有会话事件时核对工具栏。 */
export default function DiffPreview() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("project") ?? "";
  const files = useMemo(() => previewFiles(), []);
  const events = useMemo<SessionEvent[]>(
    () => [
      {
        id: "preview-turn",
        session_id: "preview-session",
        seq: 1,
        ts: 1,
        kind: "turn-changes",
        turn_id: "preview-turn",
        files,
      },
    ],
    [files],
  );
  return (
    <div className="h-screen w-screen overflow-hidden bg-wb-surface text-wb-fg">
      <ProjectPanel projectId={projectId} path={params.get("path") ?? ""} title="梳理需求" events={events}>
        <AnswerMarkdownHost>
          <SessionSplit>
            <DiffSeed files={files} />
          </SessionSplit>
        </AnswerMarkdownHost>
      </ProjectPanel>
    </div>
  );
}

function DiffSeed({ files }: { files: FileChange[] }) {
  const { openBlank, openFiles, openDiff } = usePanel();
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    openBlank();
    openFiles();
    openDiff("preview-diff", "变更", files);
  }, [files, openBlank, openDiff, openFiles]);
  return <div className="min-h-0 flex-1" />;
}
