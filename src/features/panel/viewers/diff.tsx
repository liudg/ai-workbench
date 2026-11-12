import { useCallback } from "react";
import { FileDiff } from "lucide-react";

import type { FileChange } from "@/features/changes-model";
import { DiffView } from "../diff/DiffView";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { matchDiff } from "./kinds";
import { usePanel } from "../core/PanelProvider";

interface DiffPayload {
  title?: string;
  files?: FileChange[];
  focus?: { path: string };
}

function DiffViewerBody({ tabId, payload }: ViewerViewProps<DiffPayload>) {
  const { patchTabPayload } = usePanel();
  const onFocusHandled = useCallback(() => {
    patchTabPayload(tabId, { focus: undefined });
  }, [patchTabPayload, tabId]);
  return <DiffView files={payload.files ?? []} focus={payload.focus} onFocusHandled={onFocusHandled} />;
}

export const diffViewer: PanelViewer<DiffPayload> = {
  id: "diff",
  match: matchDiff,
  icon: FileDiff,
  title: (payload) => payloadTitle(payload) || "变更",
  View: DiffViewerBody,
};
