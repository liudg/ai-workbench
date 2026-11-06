import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { useAnchoredLayer } from "../core/useAnchoredLayer";
import { useDismissLayer } from "@/shared/menu/useDismissLayer";
import { dropdownTreeQuery } from "./file-preview-nav";
import { WorkspaceTree } from "./WorkspaceTree";

/** 面包屑下拉：导航层。目录段展开工作区，文件段只列同目录。 */
export function BreadcrumbMenu({
  anchor,
  projectId,
  activePath,
  segmentPath,
  last,
  workspaceRoot,
  onSelectFile,
  onClose,
}: {
  anchor: HTMLElement | null;
  projectId: string;
  activePath: string;
  segmentPath: string;
  last: boolean;
  workspaceRoot: string;
  onSelectFile: (path: string, intent: { isPreview: boolean }) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const query = dropdownTreeQuery({ activePath, segmentPath, last, workspaceRoot });
  useAnchoredLayer(true, anchorRef, popoverRef, `${segmentPath}:${projectId}`, "start");
  useDismissLayer(true, onClose);

  useEffect(() => {
    popoverRef.current?.focus();
    return () => {
      anchorRef.current?.focus();
    };
  }, [segmentPath]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      tabIndex={-1}
      data-breadcrumb-menu
      data-open-mode={query.openMode}
      data-should-expand={query.shouldExpandActivePath ? "true" : "false"}
      aria-label={DESKTOP_ZH.breadcrumbLabel}
      className="fixed z-[80] flex h-80 w-80 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414] shadow-[0_12px_32px_rgba(0,0,0,0.45)] outline-none"
    >
      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {projectId ? (
          <WorkspaceTree
            projectId={projectId}
            filter=""
            activePath={activePath}
            surface={query.surface}
            directoryPath={query.directoryPath}
            initialExpanded={query.expandedPaths}
            revealSelectedPath={query.revealSelectedPath}
            openMode={query.openMode}
            includeHidden={query.includeHidden}
            onSelectFile={onSelectFile}
          />
        ) : (
          <p className="px-2 py-6 text-center text-xs text-red-300" data-directory-error>
            {DESKTOP_ZH.directoryError}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
