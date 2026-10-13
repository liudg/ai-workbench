import { useMemo } from "react";

import type { FileChange } from "@/features/changes-model/diff-parse";
import type { SessionEvent } from "@/types";
import { PanelProvider } from "../core/PanelProvider";
import { DiffView } from "./DiffView";

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
  { path: "Library/GemFeedback/inspect_prefab.cs", status: "M", added: 2, removed: 1, diff: INSPECT },
  { path: "Library/GemFeedback/invoke.ps1", status: "M", added: 1, removed: 1, diff: INVOKE },
  { path: "Scripts/GameUI/Module/PlayerEquipmentBaoshi.cs", status: "M", added: 1, removed: 0, diff: BAOSHI },
  { path: "Library/GemFeedback/spacing.txt", status: "M", added: 1, removed: 1, diff: SPACING },
  { path: "Library/GemFeedback/note.md", status: "M", added: 2, removed: 1, diff: NOTE },
];

/** 开发预览：挂上真实差异视图，方便在没有会话事件时核对工具栏。 */
export default function DiffPreview() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("project") ?? "";
  const events = useMemo<SessionEvent[]>(
    () => [
      {
        id: "preview-turn",
        session_id: "preview-session",
        seq: 1,
        ts: 1,
        kind: "turn-changes",
        turn_id: "preview-turn",
        files: FILES,
      },
    ],
    [],
  );
  return (
    <div className="h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-200">
      <PanelProvider
        sessionId="preview-session"
        projectId={projectId}
        projectPath={params.get("path") ?? ""}
        sessionTitle="变更"
        agent="codex-cli"
        events={events}
      >
        <DiffView files={FILES} />
      </PanelProvider>
    </div>
  );
}
