//! 项目文件：把链接或相对路径解析到项目里的文件，按文本或图片读出来预览；
//! 一层一层列目录、按文件名筛选、搜正文。
//!
//! 工作区目录按一层一层列，不设全局文件上限。路径索引在后台建，遵守 `.gitignore`
//! （含嵌套规则和全局排除）。`.git`、`node_modules`、`target`、`dist`、`Library`、
//! `Temp` 仍然跳过。文件名筛选不读正文；内容搜索单独打开文件。

mod image;
mod image_codec;
mod index;
mod path;
mod read;
mod search;
mod tree;

pub use image::{read_image_at, PreviewImage};
pub use image_codec::{classify_preview_image, encode_base64, image_extension, sniff_image};
pub use path::{file_name, preview_kind, resolve_preview_file, skip_tree_dir};
pub use read::{read_preview_at, PreviewDocument};
pub use search::{quick_open_indexed, search_blocking, IndexHub, IndexedPaths, SearchHit, SearchOutput, QUICK_OPEN_LIMIT};
pub use tree::{filter_paths, list_dir_at, FilterHub, PathFilter, TreeEntry};
