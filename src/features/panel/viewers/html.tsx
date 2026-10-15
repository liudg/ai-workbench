import { pageTitleFromHtml } from "@/shared/html-title";
import { baseName } from "@/shared/path";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { NewTabIcon } from "./new-tab-icon";
import { BrowserView } from "../browser/BrowserView";
import {
  payloadTitle,
  type OpenTarget,
  type PanelViewer,
  type ViewerViewProps,
} from "../core/registry";
import { readPreviewDocument, reopenIfDifferent } from "./document";
import { PreviewFailed } from "./frame";
import { matchHtml } from "./kinds";

interface HtmlPayload {
  title?: string;
  path?: string;
  url?: string;
  text?: string;
  truncated?: boolean;
  error?: string;
  line?: number | null;
}

function htmlTitle(payload: HtmlPayload): string {
  return (
    payloadTitle(payload) ||
    baseName(payload.path || payload.url || "") ||
    DESKTOP_ZH.browserNewTab
  );
}

function HtmlViewerBody({ payload, status, tabId, projectId, sessionId, setTitle }: ViewerViewProps<HtmlPayload>) {
  if (status === "error") return <PreviewFailed message={payload.error ?? ""} />;
  return (
    <BrowserView
      tabId={tabId}
      projectId={projectId}
      sessionId={sessionId}
      path={payload.path ?? ""}
      initialUrl={payload.url}
      text={payload.text ?? ""}
      onTitle={setTitle}
    />
  );
}

export const htmlViewer: PanelViewer<HtmlPayload> = {
  id: "html",
  match: matchHtml,
  icon: NewTabIcon,
  title: htmlTitle,
  async load(target: OpenTarget, ctx) {
    if (target.kind !== "file") {
      return { title: DESKTOP_ZH.browserNewTab, path: "", text: "", truncated: false };
    }
    const doc = await readPreviewDocument(ctx, target.path);
    reopenIfDifferent(doc.kind, "html", target.path, target.line);
    return {
      title: pageTitleFromHtml(doc.text) || baseName(target.path),
      path: target.path,
      text: doc.text,
      truncated: doc.truncated,
      line: target.line,
    };
  },
  View: HtmlViewerBody,
};
