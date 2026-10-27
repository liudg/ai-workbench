//! 工作目录里的文件和差异：一层一层列目录、按文件名筛选、搜正文、读文本和图片、看差异。
//! 有会话时读会话的工作目录，还没建会话时读项目主目录。路径都相对这个目录。

use std::path::Path;

use aiwb_agents::{default_git_scopes, DiffScope};
use aiwb_files::{IndexedPaths, PathFilter, PreviewDocument, PreviewImage, SearchOutput, TreeEntry, QUICK_OPEN_LIMIT};
use serde::Deserialize;

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

    /// 按文本读出来。
    pub(crate) async fn read_file(&self, params: ReadPath) -> ServiceResult<PreviewDocument> {
        let root = self.scope_dir(&params.scope)?;
        blocking(move || aiwb_files::read_preview_at(&root, &params.path)).await?
    }

    pub(crate) async fn read_image(&self, params: ReadPath) -> ServiceResult<PreviewImage> {
        let root = self.scope_dir(&params.scope)?;
        blocking(move || aiwb_files::read_image_at(Path::new(&root), &params.path)).await?
    }

    /// 差异面板的范围：会话还有 Agent 给的上一轮，项目只有 git 的几种。
    pub(crate) async fn diff_scopes(&self, scope: Scope) -> ServiceResult<Vec<DiffScope>> {
        let Some(session_id) = scope.session_id.as_deref() else {
            return Ok(default_git_scopes());
        };
        let handle = self.runtimes.handle(session_id).await?;
        handle.diff_scopes().await.map_err(|e| e.to_string())
    }

    pub(crate) async fn diff(&self, params: Diff) -> ServiceResult<String> {
        let root = self.scope_dir(&params.scope)?;
        let Some(session_id) = params.scope.session_id.as_deref() else {
            return blocking(move || aiwb_git::git_diff_text(&root, &params.diff_scope, params.ignore_whitespace))
                .await?;
        };
        let handle = self.runtimes.handle(session_id).await?;
        handle
            .diff_for_scope(&root.to_string_lossy(), &params.diff_scope, params.ignore_whitespace)
            .await
            .map_err(|e| e.to_string())
    }
}
