import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { backend } from "@/lib/ipc";
import type { SessionEvent } from "@/types";
import { clearBrowserHistories, forgetHistory, pageTitleFromHtml } from "./browser";
import { CODEX_DESKTOP } from "../codex-desktop";
import {
  baseName,
  previewKindForPath,
  resolvePreviewPath,
  sameFile,
  sessionChanges,
  type FileChange,
  type PreviewKind,
} from "./model";

export type PreviewTab =
  | { id: string; kind: "diff"; title: string; files: FileChange[] }
  | {
      id: string;
      kind: PreviewKind;
      title: string;
      path: string;
      status: "loading" | "ready" | "error";
      text: string;
      truncated: boolean;
      error: string;
    };

interface PreviewApi {
  tabs: PreviewTab[];
  activeId: string;
  projectId: string;
  sessionFiles: FileChange[];
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  openDiff: (id: string, title: string, files: FileChange[]) => void;
  openHref: (href: string) => void;
  openBlank: () => void;
  setTabTitle: (id: string, title: string) => void;
}

const PreviewContext = createContext<PreviewApi | null>(null);

export function usePreview(): PreviewApi {
  const value = useContext(PreviewContext);
  if (!value) throw new Error("预览尚未就绪");
  return value;
}

export function usePreviewOptional(): PreviewApi | null {
  return useContext(PreviewContext);
}

function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "无法读取文件";
}

function documentTab(id: string, kind: PreviewKind, path: string): PreviewTab {
  return {
    id,
    kind,
    title: baseName(path),
    path,
    status: "loading",
    text: "",
    truncated: false,
    error: "",
  };
}

export function PreviewProvider({
  sessionId,
  projectId,
  projectPath,
  events,
  children,
}: {
  sessionId: string;
  projectId: string;
  projectPath: string;
  events: readonly SessionEvent[];
  children: ReactNode;
}) {
  const [tabs, setTabs] = useState<PreviewTab[]>([]);
  const [activeId, setActiveId] = useState("");
  const [boundSession, setBoundSession] = useState(sessionId);
  const tickets = useRef(new Map<string, number>());
  const ticket = useRef(0);
  if (boundSession !== sessionId) {
    setBoundSession(sessionId);
    setTabs([]);
    setActiveId("");
    tickets.current.clear();
    clearBrowserHistories();
  }

  const sessionFiles = useMemo(() => sessionChanges(events), [events]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const filesRef = useRef(sessionFiles);
  filesRef.current = sessionFiles;
  const projectRef = useRef({ projectId, projectPath });
  projectRef.current = { projectId, projectPath };

  const openDiff = useCallback((id: string, title: string, files: FileChange[]) => {
    setTabs((current) => {
      const rest = current.filter((tab) => tab.id !== id);
      return [...rest, { id, kind: "diff", title, files }];
    });
    setActiveId(id);
  }, []);

  const readDocument = useCallback(
    (id: string, path: string, kind: PreviewKind) => {
      const mine = ticket.current + 1;
      ticket.current = mine;
      tickets.current.set(id, mine);
      const { projectId: currentProject, projectPath: root } = projectRef.current;
      void backend
        .readPreviewFile(currentProject, path)
        .then((doc) => {
          if (tickets.current.get(id) !== mine) return;
          if (doc.kind === "binary") {
            setTabs((current) =>
              current.map((tab) =>
                tab.id === id && tab.kind !== "diff"
                  ? { ...tab, status: "error", error: "这个文件不能以文本预览。" }
                  : tab,
              ),
            );
            return;
          }
          const nextKind =
            doc.kind === "html" || doc.kind === "markdown" || doc.kind === "text"
              ? doc.kind
              : kind;
          const htmlTitle = nextKind === "html" ? pageTitleFromHtml(doc.text) : "";
          setTabs((current) =>
            current.map((tab) =>
              tab.id === id && tab.kind !== "diff"
                ? {
                    ...tab,
                    kind: nextKind,
                    title: htmlTitle || tab.title,
                    status: "ready",
                    text: doc.text,
                    truncated: doc.truncated,
                    error: "",
                  }
                : tab,
            ),
          );
        })
        .catch((error: unknown) => {
          if (tickets.current.get(id) !== mine) return;
          const match = filesRef.current.find((file) => sameFile(root, file.path, path));
          if (match) {
            setTabs((current) => current.filter((tab) => tab.id !== id));
            openDiff(`diff-file:${match.path}`, baseName(match.path), [match]);
            return;
          }
          const message = errorText(error);
          setTabs((current) =>
            current.map((tab) =>
              tab.id === id && tab.kind !== "diff"
                ? { ...tab, status: "error", error: message }
                : tab,
            ),
          );
        });
    },
    [openDiff],
  );

  const openHref = useCallback(
    (href: string) => {
      const root = projectRef.current.projectPath;
      const resolved = resolvePreviewPath(root, href);
      if (!resolved) {
        const id = `blocked:${href}`;
        setTabs((current) => {
          if (current.some((tab) => tab.id === id)) return current;
          return [
            ...current,
            {
              id,
              kind: "text",
              title: baseName(href) || "文件",
              path: href,
              status: "error",
              text: "",
              truncated: false,
              error: "只能预览当前项目里的文件",
            },
          ];
        });
        setActiveId(id);
        return;
      }
      const kind = previewKindForPath(resolved);
      const id = `doc:${resolved.toLowerCase()}`;
      const existing = tabsRef.current.find((tab) => tab.id === id);
      if (!existing) {
        setTabs((current) => [...current, documentTab(id, kind, resolved)]);
      } else if (existing.kind !== "diff" && existing.status === "error") {
        setTabs((current) =>
          current.map((tab) => (tab.id === id ? documentTab(id, kind, resolved) : tab)),
        );
      }
      setActiveId(id);
      if (!existing || existing.kind === "diff" || existing.status !== "ready") {
        readDocument(id, resolved, kind);
      }
    },
    [readDocument],
  );

  const closeTab = useCallback((id: string) => {
    tickets.current.delete(id);
    forgetHistory(id);
    const next = tabsRef.current.filter((tab) => tab.id !== id);
    tabsRef.current = next;
    setTabs(next);
    setActiveId((active) => (active === id ? (next[next.length - 1]?.id ?? "") : active));
  }, []);

  const selectTab = useCallback((id: string) => setActiveId(id), []);

  const openBlank = useCallback(() => {
    const id = `browser:${Date.now()}`;
    setTabs((current) => [
      ...current,
      {
        id,
        kind: "html",
        title: CODEX_DESKTOP.browserEmptyTitle,
        path: "",
        status: "ready",
        text: "",
        truncated: false,
        error: "",
      },
    ]);
    setActiveId(id);
  }, []);

  const setTabTitle = useCallback((id: string, title: string) => {
    const next = title.trim();
    if (!next) return;
    setTabs((current) =>
      current.map((tab) => (tab.id === id && tab.title !== next ? { ...tab, title: next } : tab)),
    );
  }, []);

  useEffect(() => {
    return () => {
      clearBrowserHistories();
      void backend.browserClose();
    };
  }, []);

  const api = useMemo<PreviewApi>(
    () => ({
      tabs,
      activeId,
      projectId,
      sessionFiles,
      selectTab,
      closeTab,
      openDiff,
      openHref,
      openBlank,
      setTabTitle,
    }),
    [tabs, activeId, projectId, sessionFiles, selectTab, closeTab, openDiff, openHref, openBlank, setTabTitle],
  );

  return <PreviewContext.Provider value={api}>{children}</PreviewContext.Provider>;
}
