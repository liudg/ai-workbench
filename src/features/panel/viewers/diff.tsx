import { FileDiff } from "lucide-react";

import type { FileChange } from "@/features/changes-model/diff-parse";
import { DiffView } from "../diff/DiffView";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { matchDiff } from "./kinds";

interface DiffPayload {
  title?: string;
  files?: FileChange[];
}

function DiffViewerBody({ payload }: ViewerViewProps<DiffPayload>) {
  return <DiffView files={payload.files ?? []} />;
}

export const diffViewer: PanelViewer<DiffPayload> = {
  id: "diff",
  match: matchDiff,
  icon: FileDiff,
  title: (payload) => payloadTitle(payload) || "变更",
  View: DiffViewerBody,
};
