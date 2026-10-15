import { useRef } from "react";
import { Code } from "lucide-react";

import { insertComposerText } from "@/shared/composer-insert";
import { usePanelOptional } from "../core/PanelProvider";
import { baseName } from "../files/path";
import { SelectionMenu } from "../files/SelectionMenu";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { SourceView } from "./SourceView";
import { TextPreview } from "./TextPreview";
import { readPreviewDocument, reopenIfDifferent } from "./document";
import { PreviewFailed, PreviewPending } from "./frame";
import { matchText } from "./kinds";

interface TextPayload {
  title?: string;
  path?: string;
  text?: string;
  truncated?: boolean;
  line?: number | null;
  error?: string;
}

function TextViewerBody({ payload, status }: ViewerViewProps<TextPayload>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panel = usePanelOptional();
  const path = payload.path ?? "";
  let body = <TextPreview text={payload.text ?? ""} truncated={Boolean(payload.truncated)} />;
  if (status === "loading") body = <PreviewPending />;
  else if (status === "error") body = <PreviewFailed message={payload.error ?? ""} />;
  else if (payload.line != null) body = <SourceView text={payload.text ?? ""} line={payload.line} />;
  return (
    <div ref={rootRef} data-open-files-preview className="h-full min-h-0">
      {body}
      {status === "ready" && path && panel ? (
        <SelectionMenu
          rootRef={rootRef}
          path={path}
          onAdd={(quote) => {
            insertComposerText(panel.sessionId, quote);
          }}
        />
      ) : null}
    </div>
  );
}

export const textViewer: PanelViewer<TextPayload> = {
  id: "text",
  match: matchText,
  icon: Code,
  title: (payload) => payloadTitle(payload) || baseName(payload.path || "") || "文件",
  async load(target, ctx) {
    if (target.kind !== "file") return { title: "文件", text: "", truncated: false, line: null };
    const doc = await readPreviewDocument(ctx, target.path);
    reopenIfDifferent(doc.kind, "text", target.path, target.line);
    return {
      title: baseName(target.path),
      path: target.path,
      text: doc.text,
      truncated: doc.truncated,
      line: target.line,
    };
  },
  View: TextViewerBody,
};
