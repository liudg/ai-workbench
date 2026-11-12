import { attentionPill, type Attention } from "../../../shared/attention/attention.ts";

/**
 * 时间线里一行子任务的状态字和颜色。照 t3code `apps/web/src/components/chat/V2LifecycleRow.tsx` 的
 * `STATUS_VISUALS`：运行中蓝点，完成绿点，失败红点，停下灰点；等你批准或回答时和侧栏的药丸同色同字。
 */
export interface SubtaskStatusView {
  label: string;
  /** 头像右下角的状态点。 */
  dotClass: string;
  /** 状态字的颜色。 */
  textClass: string;
  running: boolean;
}

export function subtaskStatus(attention: Attention): SubtaskStatusView {
  switch (attention.state) {
    case "starting":
      return { label: "正在启动", dotClass: "bg-wb-accent", textClass: "text-wb-fg-2", running: true };
    case "new":
      return { label: "未开始", dotClass: "bg-wb-dim", textClass: "text-wb-fg-3", running: false };
    case "working":
      return { label: "运行中", dotClass: "bg-wb-accent", textClass: "text-wb-fg-2", running: true };
    case "needs-input": {
      const pill = attentionPill(attention);
      return {
        label: pill?.label ?? "待回答",
        dotClass: pill?.dotClass ?? "bg-wb-warn",
        textClass: pill?.textClass ?? "text-wb-warn",
        running: false,
      };
    }
    case "done":
      return { label: "完成", dotClass: "bg-wb-ok", textClass: "text-wb-fg-2", running: false };
    case "failed":
      return { label: "失败", dotClass: "bg-wb-danger", textClass: "text-wb-danger", running: false };
    case "idle":
      return { label: "已停止", dotClass: "bg-wb-dim", textClass: "text-wb-fg-3", running: false };
  }
}

/** 第二行：最新一句活动或结果，单行。没有时用状态字。 */
export function subtaskDetail(attention: Attention): string {
  return attention.preview?.replace(/\s+/g, " ").trim() ?? "";
}
