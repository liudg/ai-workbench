import type { ReactNode } from "react";

import { groupByDirectory } from "./model";

export function FileDirectoryGroups<T extends { path: string }>({
  files,
  render,
}: {
  files: readonly T[];
  render: (file: T) => ReactNode;
}) {
  const groups = groupByDirectory(files);
  return (
    <>
      {groups.map((group) => (
        <div key={group.dir || "__root"}>
          {group.dir ? (
            <div
              data-file-dir={group.dir}
              className="truncate px-2 py-1 font-mono text-[11px] text-zinc-500"
            >
              {group.dir}
            </div>
          ) : null}
          {group.files.map((file) => render(file))}
        </div>
      ))}
    </>
  );
}
