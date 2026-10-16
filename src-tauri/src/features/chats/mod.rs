//! 独立聊天：工作台自己准备一个普通工作目录，会话仍按项目会话跑。

mod folder;
mod slug;

pub use folder::{
    documents_dir, provision_standalone_chat, remove_empty_dir, rollback_standalone, today,
    TaskFolderStore, TaskFolderView,
};
