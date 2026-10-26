//! 任务工作目录里的文件：一层一层列目录、按文件名筛选、搜正文、读图片。路径都相对会话的工作目录。

use std::path::{Path, PathBuf};

use aiwb_files::{PathFilter, PreviewImage, SearchOutput, TreeEntry};
use serde::Deserialize;

use super::{ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListDir {
    session_id: String,
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilterPaths {
    session_id: String,
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchFiles {
    session_id: String,
    query: String,
    #[serde(default)]
    mask: String,
    search_id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadImage {
    session_id: String,
    path: String,
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> ServiceResult<T> {
    tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())
}

impl Services {
    fn workdir_path(&self, session_id: &str) -> ServiceResult<PathBuf> {
        Ok(PathBuf::from(self.runtimes.workdir(session_id)?))
    }

    pub(crate) async fn list_dir(&self, params: ListDir) -> ServiceResult<Vec<TreeEntry>> {
        let root = self.workdir_path(&params.session_id)?;
        blocking(move || aiwb_files::list_dir_at(&root, &params.path)).await?
    }

    /// 同一会话后来的筛选让还没跑完的这一次作废。
    pub(crate) async fn filter_paths(&self, params: FilterPaths) -> ServiceResult<PathFilter> {
        let root = self.workdir_path(&params.session_id)?;
        let filters = self.filters.fork();
        let indexes = self.indexes.fork();
        blocking(move || aiwb_files::filter_paths(&filters, &indexes, &params.session_id, root, &params.query)).await
    }

    /// 分段返回。同一个 `searchId` 接着要下一段，换了 id 就是新的一次搜索。
    pub(crate) async fn search_files(&self, params: SearchFiles) -> ServiceResult<SearchOutput> {
        let root = self.workdir_path(&params.session_id)?;
        let indexes = self.indexes.fork();
        blocking(move || {
            aiwb_files::search_blocking(&indexes, root, &params.query, &params.mask, params.search_id)
        })
        .await
    }

    pub(crate) async fn read_image(&self, params: ReadImage) -> ServiceResult<PreviewImage> {
        let root = self.workdir_path(&params.session_id)?;
        blocking(move || aiwb_files::read_image_at(Path::new(&root), &params.path)).await?
    }
}
