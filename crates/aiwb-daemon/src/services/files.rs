//! 工作目录里的文件和差异：一层一层列目录、按文件名筛选、搜正文、读文本和图片、看差异。
//! 有会话时读会话的工作目录，还没建会话时读项目主目录。路径都相对这个目录。

use std::path::Path;

use aiwb_agents::{default_git_scopes, is_turn_scope, turn_scope, DiffScope};
use aiwb_core::models::strip_verbatim_prefix;
use aiwb_files::{IndexedPaths, PathFilter, PreviewDocument, PreviewImage, SearchOutput, TreeEntry, QUICK_OPEN_LIMIT};
use serde::{Deserialize, Serialize};

use super::{blocking, scope_key, Scope, ServiceResult, Services};

#[derive(Deserialize)]
pub(crate) struct ListDir {
    #[serde(flatten)]
    scope: Scope,
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
pub(crate) struct FilterPaths {
    #[serde(flatten)]
    scope: Scope,
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchFiles {
    #[serde(flatten)]
    scope: Scope,
    query: String,
    #[serde(default)]
    mask: String,
    search_id: u64,
}

#[derive(Deserialize)]
pub(crate) struct ReadPath {
    #[serde(flatten)]
    scope: Scope,
    path: String,
}

#[derive(Serialize)]
pub(crate) struct ResolvedPath {
    exists: bool,
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Diff {
    #[serde(flatten)]
    scope: Scope,
    #[serde(rename = "scope")]
    diff_scope: String,
    #[serde(default)]
    ignore_whitespace: bool,
}

impl Services {
    pub(crate) async fn list_dir(&self, params: ListDir) -> ServiceResult<Vec<TreeEntry>> {
        let root = self.scope_dir(&params.scope)?;
        blocking(move || aiwb_files::list_dir_at(&root, &params.path)).await?
    }

    /// 同一目录后来的筛选让还没跑完的这一次作废。
    pub(crate) async fn filter_paths(&self, params: FilterPaths) -> ServiceResult<PathFilter> {
        let root = self.scope_dir(&params.scope)?;
        let key = scope_key(&params.scope);
        let filters = self.filters.fork();
        let indexes = self.indexes.fork();
        blocking(move || aiwb_files::filter_paths(&filters, &indexes, &key, root, &params.query)).await
    }

    /// 跳转文件：空查询也列出一批文件。索引还没建完时 `ready` 为 false，接着再要。
    pub(crate) async fn quick_open(&self, params: FilterPaths) -> ServiceResult<IndexedPaths> {
        let root = self.scope_dir(&params.scope)?;
        let indexes = self.indexes.fork();
        blocking(move || aiwb_files::quick_open_indexed(&indexes, root, &params.query, QUICK_OPEN_LIMIT)).await
    }

    /// 分段返回。同一个 `searchId` 接着要下一段，换了 id 就是新的一次搜索。
    pub(crate) async fn search_files(&self, params: SearchFiles) -> ServiceResult<SearchOutput> {
        let root = self.scope_dir(&params.scope)?;
        let indexes = self.indexes.fork();
        blocking(move || {
            aiwb_files::search_blocking(&indexes, root, &params.query, &params.mask, params.search_id)
        })
        .await
    }

    /// 只确认路径是不是磁盘上的文件，不读正文。支持引号剥离、兼容 `git diff` 的 `a/` `b/`（含反斜杠）前缀与前导 `/` 仓库相对路径回退。
    pub(crate) async fn resolve_file(&self, params: ReadPath) -> ServiceResult<ResolvedPath> {
        let root = self.scope_dir(&params.scope)?;
        blocking(move || {
            let cleaned = params.path.trim().trim_matches(['"', '\'', '`']).trim();
            let resolved = aiwb_files::resolve_preview_file(&root, cleaned)
                .or_else(|err| {
                    let stripped = cleaned
                        .strip_prefix("a/")
                        .or_else(|| cleaned.strip_prefix("b/"))
                        .or_else(|| cleaned.strip_prefix("a\\"))
                        .or_else(|| cleaned.strip_prefix("b\\"));
                    match stripped {
                        Some(rest) if !rest.is_empty() => {
                            aiwb_files::resolve_preview_file(&root, rest)
                        }
                        _ => Err(err),
                    }
                })
                .or_else(|err| {
                    let without_slash = cleaned.trim_start_matches('/');
                    if without_slash != cleaned && !without_slash.is_empty() {
                        aiwb_files::resolve_preview_file(&root, without_slash)
                    } else {
                        Err(err)
                    }
                });
            match resolved {
                Ok(full) => ResolvedPath {
                    exists: true,
                    path: Some(strip_verbatim_prefix(&full.to_string_lossy())),
                },
                Err(_) => ResolvedPath {
                    exists: false,
                    path: None,
                },
            }
        })
        .await
    }

    /// 按文本读出来。
    pub(crate) async fn read_file(&self, params: ReadPath) -> ServiceResult<PreviewDocument> {
        let root = self.scope_dir(&params.scope)?;
        blocking(move || aiwb_files::read_preview_at(&root, &params.path)).await?
    }

    pub(crate) async fn read_image(&self, params: ReadPath) -> ServiceResult<PreviewImage> {
        let root = self.scope_dir(&params.scope)?;
        blocking(move || aiwb_files::read_image_at(Path::new(&root), &params.path)).await?
    }

    /// 差异面板的范围：会话还有上一轮，项目只有 git 的几种。
    /// Agent 已接上就问它；没接上不为看差异去启动 CLI，上一轮是否可用由前端按 Agent 的能力过滤。
    pub(crate) async fn diff_scopes(&self, scope: Scope) -> ServiceResult<Vec<DiffScope>> {
        let Some(session_id) = scope.session_id.as_deref() else {
            return Ok(default_git_scopes());
        };
        if let Some(handle) = self.runtimes.live_handle(session_id) {
            return handle.diff_scopes().await.map_err(|e| e.to_string());
        }
        let mut scopes = vec![turn_scope()];
        scopes.extend(default_git_scopes());
        Ok(scopes)
    }

    /// git 的几种范围直接在工作目录上跑 git，不经过 Agent；只有上一轮要问 Agent。
    pub(crate) async fn diff(&self, params: Diff) -> ServiceResult<String> {
        let root = self.scope_dir(&params.scope)?;
        let session_id = match params.scope.session_id.as_deref() {
            Some(id) if is_turn_scope(&params.diff_scope) => id,
            _ => {
                return blocking(move || aiwb_git::git_diff_text(&root, &params.diff_scope, params.ignore_whitespace))
                    .await?;
            }
        };
        // 工作树清理掉了不为看上一轮差异把它建回来。
        if self.shelved_agent(session_id)?.is_some() {
            return Err("工作树已清理，恢复后再看上一轮的改动".into());
        }
        let root = root.to_string_lossy().into_owned();
        let (scope, ignore_whitespace) = (params.diff_scope, params.ignore_whitespace);
        self.runtimes
            .with_handle(session_id, move |handle| {
                let (root, scope) = (root.clone(), scope.clone());
                async move { handle.diff_for_scope(&root, &scope, ignore_whitespace).await }
            })
            .await
    }
}
