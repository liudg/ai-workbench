// 文件面板的数据形状：目录、筛选、搜索、预览、差异范围。由 daemon 的 `files.*` 返回。

export interface TreeEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | string;
}

export interface PathFilter {
  paths: string[];
  truncated: boolean;
  cancelled: boolean;
  /** 索引还在建时为 false，接着要下一段。 */
  ready: boolean;
}

export interface FileSearchHit {
  path: string;
  line: number | null;
  text: string;
  kind: "content" | "name" | string;
}

export interface FileSearchResult {
  hits: FileSearchHit[];
  truncated: boolean;
  done: boolean;
  cancelled: boolean;
}

export interface PreviewDocument {
  path: string;
  name: string;
  kind: string;
  text: string;
  truncated: boolean;
}

export interface PreviewImage {
  path: string;
  name: string;
  mime: string;
  data_base64: string;
}

export interface DiffScope {
  id: string;
  label: string;
  /** `git` 或 `turn`。 */
  source: string;
}
