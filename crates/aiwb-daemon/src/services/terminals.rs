//! 终端的对外方法。新终端开在会话的工作目录里，还没建会话时开在项目主目录。

use serde::Deserialize;

use super::{Scope, ServiceResult, Services};
use crate::terminals::OpenedTerminal;

#[derive(Deserialize)]
pub(crate) struct OpenTerminal {
    #[serde(flatten)]
    scope: Scope,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
pub(crate) struct TerminalId {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdoptTerminal {
    id: String,
    session_id: String,
}

#[derive(Deserialize)]
pub(crate) struct ResizeTerminal {
    id: String,
    cols: u16,
    rows: u16,
}

impl Services {
    pub(crate) fn open_terminal(&self, params: OpenTerminal) -> ServiceResult<OpenedTerminal> {
        let cwd = self.scope_dir(&params.scope)?;
        let owner = params.scope.session_id.clone();
        self.terminals.open(&cwd, owner, params.cols, params.rows)
    }

    pub(crate) fn adopt_terminal(&self, params: AdoptTerminal) -> ServiceResult<()> {
        self.terminals.adopt(&params.id, &params.session_id)
    }

    pub(crate) fn resize_terminal(&self, params: ResizeTerminal) -> ServiceResult<()> {
        self.terminals.resize(&params.id, params.cols, params.rows)
    }

    pub(crate) fn close_terminal(&self, params: TerminalId) -> ServiceResult<()> {
        self.terminals.close(&params.id);
        Ok(())
    }
}
