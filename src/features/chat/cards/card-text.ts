import { baseName } from "../../panel/files/path.ts";
import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";

/** 变更卡先列出的文件数，其余用「再显示」。 */
export const FILE_LIST_LIMIT = 3;

export function filesChangedLabel(count: number): string {
  return count === 1
    ? DESKTOP_ZH.fileChanged
    : DESKTOP_ZH.filesChanged.replace("{count}", String(count));
}

/** 变更卡上会出现的动作。查看变更始终在；文件超出一屏时才有再显示。 */
export function changeActions(
  fileCount: number,
  listExpanded: boolean,
  revealed: boolean,
): string[] {
  const actions: string[] = [DESKTOP_ZH.viewChanges];
  if (listExpanded && canShowMore(fileCount, revealed)) actions.push(DESKTOP_ZH.showMore);
  return actions;
}

export function canShowMore(fileCount: number, revealed: boolean): boolean {
  return !revealed && fileCount > FILE_LIST_LIMIT;
}

export function visibleChangeFiles<T>(files: readonly T[], expanded: boolean, revealed: boolean): T[] {
  if (!expanded) return [];
  if (revealed || files.length <= FILE_LIST_LIMIT) return [...files];
  return files.slice(0, FILE_LIST_LIMIT);
}

export function editedFilesLabel(files: readonly { path: string }[]): string {
  if (files.length === 1) {
    return DESKTOP_ZH.editedFile.replace("{name}", baseName(files[0]?.path ?? ""));
  }
  return DESKTOP_ZH.editedFiles.replace("{count}", String(files.length));
}
