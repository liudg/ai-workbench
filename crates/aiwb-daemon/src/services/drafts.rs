//! 作曲栏草稿。键由界面定（会话 id，或还没建会话时的项目），内容原样存取。

use serde::Deserialize;
use serde_json::Value;

use super::{now_millis, ServiceResult, Services};

#[derive(Deserialize)]
pub(crate) struct DraftKey {
    key: String,
}

#[derive(Deserialize)]
pub(crate) struct SetDraft {
    key: String,
    /// 空表示删掉。
    #[serde(default)]
    body: Option<Value>,
}

impl Services {
    pub(crate) fn draft(&self, params: DraftKey) -> ServiceResult<Option<Value>> {
        self.store.draft(&params.key).map_err(|e| e.to_string())
    }

    pub(crate) fn set_draft(&self, params: SetDraft) -> ServiceResult<()> {
        let body = params.body.filter(|body| !body.is_null());
        self.store
            .set_draft(&params.key, body.as_ref(), now_millis())
            .map_err(|e| e.to_string())
    }
}
