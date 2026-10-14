//! 差异范围和批注的历史路径。实现在中立协议层，这里继续导出，已有适配器不用改引用。

pub use super::protocol::{
    default_git_scopes, is_turn_scope, submit_annotation_as_attachment, turn_scope, AnnotationSink,
    DiffScope, DiffScopeProvider,
};
