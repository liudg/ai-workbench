import { FileText } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { OpenFilesView } from "../files/OpenFilesView";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { matchOpenFiles } from "./kinds";

function OpenFilesBody(_props: ViewerViewProps) {
  return <OpenFilesView />;
}

export const filesViewer: PanelViewer = {
  id: "files",
  match: matchOpenFiles,
  icon: FileText,
  title: (payload) => payloadTitle(payload) || DESKTOP_ZH.openFiles,
  View: OpenFilesBody,
};
