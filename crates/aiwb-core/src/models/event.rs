use serde::{Deserialize, Serialize};

use super::agent::{AgentKind, SessionId};
use super::catalog::QueuedTurn;
use super::session::SessionStatus;

/// 需要用户输入的提问类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PromptKind {
    /// 审批（允许 / 拒绝）
    Approval,
    /// 多选一
    Choice,
    /// 自由文本回答
    FreeText,
    /// Codex 原生问题卡片：一轮可多题，每题编号选项 + 自由文本，可跳过
    Questions,
    /// MCP `elicitation/request`：接受 / 拒绝 / 取消，外加表单字段。
    Elicitation,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PromptOption {
    pub id: String,
    pub label: String,
    /// 选项的说明文字（Codex requestUserInput 的 description）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// 有值时这一项不可选，值是原因。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<String>,
    /// 审批卡上的位置：primary / deny / leading / scoped。空表示普通选项。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub slot: String,
    /// 悬停说明。审批的会话级选项用它。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tooltip: String,
}

/// 提问卡片的交互壳。适配器按原生协议写入，界面不看 Agent 名字。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum QuestionSurface {
    /// 阻塞式 requestUserInput：跳过 + 继续 / 提交。
    #[default]
    RequestInput,
    /// async sendUserMessageQuestion：跳过 + 下一步 / 发送。
    AsyncReply,
}

/// 问题卡片中的一道题（对应 Codex requestUserInput 的单个 question，
/// 或 async 提问消息里的一条 AsyncUserInputQuestion）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptQuestion {
    /// 阻塞式提问用 Codex 的 question id；async 提问没有 id，用 q1/q2… 按序合成
    pub id: String,
    /// 题目标签（Codex header），可空
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub header: String,
    pub question: String,
    /// 题下说明。Codex 这张卡没有单独的题目说明；Claude 的 description 放这里。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Codex isSecret。桌面端只用来关掉听写；这张卡没有听写，也不做密码掩码。
    #[serde(default)]
    pub is_secret: bool,
    /// 有选项时仍可写自定义回复（Codex isOther）。没有选项时自由输入不看这个字段。
    #[serde(default)]
    pub is_other: bool,
    /// 多选。Codex requestUserInput 的映射不带这个字段，缺省 false。
    #[serde(default)]
    pub multi_select: bool,
    /// 这道题所属卡片的按钮和占位文案。同一张卡的题应一致。
    #[serde(default)]
    pub surface: QuestionSurface,
    /// 编号展示的选项；空数组 = 纯自由文本题。elicitation 的 enum 也放这里。
    pub options: Vec<PromptOption>,
    /// elicitation 字段类型：string / number / integer / boolean。空表示普通问题。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub input_kind: String,
    /// elicitation 的 required。
    #[serde(default)]
    pub required: bool,
}

/// 前端对提问的回答。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PromptAnswer {
    /// 审批决定 / 单选项 id / 单行自由文本
    Single { value: String },
    /// 问题卡片：按题回答（题 id → 文本）；skipped 表示整卡跳过
    Questions {
        answers: std::collections::HashMap<String, String>,
        skipped: bool,
    },
    /// MCP elicitation。`action` 为 accept / decline / cancel。接受时带表单内容。
    Elicitation {
        action: String,
        #[serde(default)]
        content: std::collections::HashMap<String, serde_json::Value>,
    },
}

/// 助手文本在一轮里的位置。适配器写入，时间线只读这个字段，不比较 AgentKind。
///
/// 缺省表示协议没给阶段：时间线把该轮最后一条未标注消息当作答复。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MessagePhase {
    /// 过程中的旁白，例如「我会查看…」。后面还可能有工具或正式答复。
    Commentary,
    /// 已经成形、但后面还可能继续的回答。
    PartialAnswer,
    /// 这一轮声明的最终答复。
    FinalAnswer,
}

impl MessagePhase {
    /// 协议里的 phase 字符串。未知值保持缺省，交给时间线的兼容逻辑。
    pub fn parse(value: Option<&str>) -> Option<Self> {
        let normalized = value.map(|raw| raw.trim().to_ascii_lowercase());
        match normalized.as_deref() {
            Some("commentary") => Some(Self::Commentary),
            Some("partial_answer") | Some("partial-answer") => Some(Self::PartialAnswer),
            Some("final_answer") | Some("final-answer") => Some(Self::FinalAnswer),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanStep {
    pub step: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewFinding {
    pub title: String,
    pub location: String,
    pub body: String,
}

/// `review/start` 的目标。前端菜单和 `/review` 参数都进这里。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ReviewStart {
    Uncommitted,
    Base {
        branch: String,
    },
    Commit {
        sha: String,
        #[serde(default)]
        title: String,
    },
    /// `/review <说明>` 和菜单里的 Custom review instructions。
    Custom {
        instructions: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewCommit {
    pub sha: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewTargets {
    pub branches: Vec<String>,
    pub commits: Vec<ReviewCommit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 当前分支；分离 HEAD 时为 None。
    #[serde(default)]
    pub current_branch: Option<String>,
    /// 审查菜单文案，由适配器给出。
    #[serde(default)]
    pub labels: ReviewLabels,
}

/// 审查菜单各层的文案。Codex 取自 TUI `review_popups.rs`。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewLabels {
    pub title: String,
    pub base_branch: String,
    pub base_branch_hint: String,
    pub uncommitted: String,
    pub commit: String,
    pub custom: String,
    pub branch_title: String,
    pub branch_subtitle: String,
    pub branch_search: String,
    pub commit_title: String,
    pub commit_search: String,
    pub custom_placeholder: String,
}

/// 内置浏览器批注。适配层把它折进用户回合，具体 Agent 不再单独解析。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PageAnnotation {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub selector: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub x: i32,
    #[serde(default)]
    pub y: i32,
    #[serde(default)]
    pub width: i32,
    #[serde(default)]
    pub height: i32,
    /// `element` 或 `region`。
    #[serde(default)]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
    #[serde(rename = "snapshotFailed", default, skip_serializing_if = "is_false")]
    pub snapshot_failed: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

/// 归一化文件状态：新增 / 修改 / 删除 / 重命名。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileStatus {
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "R")]
    Renamed,
}

/// `turn-changes.files[]` 里的一个文件。`file-change` 事件另外带 `turn_id`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub status: FileStatus,
    pub added: u32,
    pub removed: u32,
    pub diff: String,
}

/// 交接带多少前文：新线程从头交全部，接回这个 Agent 原来的线程时只补它没看到的那段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HandoffStrategy {
    Full,
    Delta,
}

/// 会话事件体（时间线中的一条）。`kind` 字段作为判别标签。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SessionEventBody {
    UserMessage {
        text: String,
        /// 本机路径或 `data:` / `https:` 图片。气泡用缩略图，不把文件名拼进文本。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<String>,
        /// 浏览器批注条数。大于 0 时时间线显示「N 条注释」，正文仍只给 Agent。
        #[serde(default, skip_serializing_if = "is_zero")]
        annotations: u32,
    },
    AgentMessage {
        text: String,
        /// 同一条流式回复复用这个 id，会话层会覆盖已有事件而不是追加。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
        /// 适配器标出的阶段。缺省不是「最终答复」，只是阶段未知。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<MessagePhase>,
        /// 计划模式等由适配器标出。缺省表示不是计划模式。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        /// 这条消息与另一条事件重复。值为来源 id，例如审查结果的 item id。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dedupe_of: Option<String>,
    },
    /// 模型思考。有 `stream_id` 时覆盖同一条，而不是追加。
    Thinking {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
    },
    ToolCall {
        name: String,
        summary: String,
        /// 命令输出、补丁正文、MCP 参数和结果。时间线默认折叠。
        #[serde(default, skip_serializing_if = "String::is_empty")]
        detail: String,
        /// 同一条命令或补丁的流式更新复用这个 id。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
        /// 历史或生成结果里的图片。气泡用缩略图。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<String>,
    },
    /// Agent 发起的提问；在被 PromptResolved 覆盖前，会话处于 needs-input
    Prompt {
        prompt_id: String,
        prompt_kind: PromptKind,
        question: String,
        options: Vec<PromptOption>,
        /// prompt_kind == Questions 时的逐题内容；其它类型为空
        #[serde(default)]
        questions: Vec<PromptQuestion>,
        /// 审批卡标题上方的类别，例如「终端」「编辑文件」。
        #[serde(default, skip_serializing_if = "String::is_empty")]
        header: String,
        /// 标题下方的一行说明。网络审批把原因放在这里。
        #[serde(default, skip_serializing_if = "String::is_empty")]
        subtitle: String,
        /// 命令或文件列表正文。
        #[serde(default, skip_serializing_if = "String::is_empty")]
        body: String,
        /// `command` 用三行折叠；`files` 用可滚动文件列表。空则按普通正文。
        #[serde(default, skip_serializing_if = "String::is_empty")]
        body_kind: String,
        /// 「原因」行。适配器没给就不出这一行。
        #[serde(default, skip_serializing_if = "String::is_empty")]
        reason: String,
    },
    PromptResolved {
        prompt_id: String,
        answer: String,
    },
    StatusChanged {
        status: SessionStatus,
    },
    System {
        text: String,
    },
    /// 线程已被另一个进程占用。历史可以看，但不能发送。
    ReadOnly {
        text: String,
    },
    Error {
        message: String,
    },
    /// 换 Agent 或分叉时把前文交给新 Agent。时间线画成一条分隔。
    /// 首条消息发出前 `delivered` 为 false；发出时前文拼在那条消息前面，再记下挑了几条、省了几条。
    /// 照 t3code `apps/server/src/orchestration-v2/ContextHandoffService.ts`。
    Handoff {
        from_agent: AgentKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_model: Option<String>,
        to_agent: AgentKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to_model: Option<String>,
        strategy: HandoffStrategy,
        #[serde(default, skip_serializing_if = "is_false")]
        delivered: bool,
        #[serde(default, skip_serializing_if = "is_zero")]
        selected: u32,
        #[serde(default, skip_serializing_if = "is_zero")]
        omitted: u32,
    },
    /// 作曲栏排队列表。会话层拦截，不写入时间线。
    QueueChanged {
        items: Vec<QueuedTurn>,
    },
    /// 隐藏锚点。`turn/started` 在用户消息之后发出，供 diff 绑定。
    TurnAnchor {
        turn_id: String,
        /// 该回合处于计划模式时为 `plan`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
    },
    /// `turn/diff/updated`。同一 `turn_id` 覆盖上一条。
    TurnDiff {
        turn_id: String,
        diff: String,
    },
    /// 一个文件的归一化变更。同一 `turn_id` + `path` 覆盖上一条。
    FileChange {
        turn_id: String,
        path: String,
        status: FileStatus,
        added: u32,
        removed: u32,
        diff: String,
    },
    /// 一轮文件变更汇总。同一 `turn_id` 覆盖上一条。
    TurnChanges {
        turn_id: String,
        files: Vec<FileChange>,
    },
    /// `turn/plan/updated`。同一 `turn_id` 覆盖上一条。
    PlanSteps {
        turn_id: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        explanation: String,
        steps: Vec<PlanStep>,
        /// 计划事件来自计划模式。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
    },
    /// plan item 的正文。同一 `stream_id` 覆盖。
    PlanText {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
    },
    /// `enteredReviewMode` 的 user-facing hint。
    ReviewNote {
        text: String,
    },
    /// `exitedReviewMode` 解析后的审查结果。解析失败时 findings 为空。
    ReviewFindings {
        summary: String,
        /// 空结果也要写出。省略时前端会对 `undefined` 调用 `reduce`，整页空白。
        #[serde(default)]
        findings: Vec<ReviewFinding>,
        raw: String,
    },
    /// 作曲栏 Plan 开关。不进时间线正文。
    CollaborationMode {
        mode: String,
    },
    /// 线程目标。`objective` 为空表示已清除。不进时间线，作曲栏用它画目标芯片。
    Goal {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        objective: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        /// `thread/goal` 的 `tokenBudget`。没有预算时不写。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token_budget: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tokens_used: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        time_used_seconds: Option<i64>,
    },
    /// 上下文窗口或本回合 token。不进时间线。缺的数字不写，界面不补 0。
    /// `source` 为 `get_context_usage`（窗口）或 `partial-usage`（本回合）。
    ContextUsage {
        source: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        used_tokens: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_tokens: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        percentage: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_tokens: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_tokens: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// 当前会话的 token 累计。不进时间线，也不进作曲栏。缺的数字不写。
    /// `scope = snapshot`：这一份就是会话累计，后到的快照替换前面的。
    /// `scope = delta`：按 `key` 记一次；同一 key 后来的值替换这一条，再把各条相加。
    SessionUsage {
        scope: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_tokens: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_tokens: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_read_tokens: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_write_tokens: Option<i64>,
    },
    /// 适配器请求宿主在同一项目里开一个新会话（`/new`、`/clear`、计划的「清空上下文后实施」）。
    /// 会话管理器不把它写进时间线，而是转给前端去新建、命名并发出首条消息。
    NewThread {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        /// 新会话在一个新的 Git 工作树里运行。
        #[serde(default, skip_serializing_if = "is_false")]
        worktree: bool,
    },
}

/// 打开已被其他进程持有写锁的 Codex 线程时，给时间线和发送拒绝用的同一句说明。
pub const OCCUPIED_SESSION_NOTICE: &str =
    "这个 Codex 会话正在被另一个进程占用，已只读打开。可以查看历史，不能在这里发送。";

/// 带序列号与时间戳的完整事件（IPC 传输与前端渲染的单位）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub id: String,
    pub session_id: SessionId,
    pub seq: u64,
    pub ts: i64,
    #[serde(flatten)]
    pub body: SessionEventBody,
}

/// 去掉 Windows `\\?\` 前缀，避免界面和 Codex 工作目录显示成 `\\?\F:\...`。
pub fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.to_string()
}

/// 比较目录用的键：去掉 `\?\` 前缀和末尾分隔符，Windows 路径不分大小写。
pub fn cwd_key(path: &str) -> String {
    let stripped = strip_verbatim_prefix(path.trim());
    let trimmed = stripped.trim_end_matches(['\\', '/']);
    // Windows 路径不区分大小写。带盘符或 UNC 的字符串在任何宿主上都按这个规则折叠，
    // 避免同一目录因为 `F:\App` / `f:\app` 对不上。POSIX 路径保持原样。
    if cfg!(windows) || looks_like_windows_path(trimmed) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn looks_like_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || path.starts_with(r"\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_key_ignores_verbatim_prefix_and_case() {
        assert_eq!(cwd_key(r"\\?\F:\App\"), cwd_key(r"f:\app"));
    }

    #[test]
    fn empty_review_findings_stay_in_the_payload() {
        let body = SessionEventBody::ReviewFindings {
            summary: "通过".into(),
            findings: Vec::new(),
            raw: "通过".into(),
        };
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["kind"], "review-findings");
        assert_eq!(json["findings"], serde_json::json!([]));

        let omitted = serde_json::json!({
            "kind": "review-findings",
            "summary": "通过",
            "raw": "通过",
        });
        let parsed: SessionEventBody = serde_json::from_value(omitted).unwrap();
        match parsed {
            SessionEventBody::ReviewFindings { findings, .. } => assert!(findings.is_empty()),
            other => panic!("unexpected {other:?}"),
        }
    }
}
