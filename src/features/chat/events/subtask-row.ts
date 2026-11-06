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
      return { label: "正在启动", dotClass: "bg-[#8fb4ff]", textClass: "text-[#8a8a8a]", running: true };
    case "new":
      return { label: "未开始", dotClass: "bg-[#6a6a6a]", textClass: "text-[#8a8a8a]", running: false };
    case "working":
      return { label: "运行中", dotClass: "bg-[#8fb4ff]", textClass: "text-[#8a8a8a]", running: true };
    case "needs-input": {
      const pill = attentionPill(attention);
      return {
        label: pill?.label ?? "待回答",
        dotClass: pill?.dotClass ?? "bg-[#f0a04a]",
        textClass: pill?.textClass ?? "text-[#f0a04a]",
        running: false,
      };
    }
    case "done":
      return { label: "完成", dotClass: "bg-emerald-400", textClass: "text-[#8a8a8a]", running: false };
    case "failed":
      return { label: "失败", dotClass: "bg-red-400", textClass: "text-red-400", running: false };
    case "idle":
      return { label: "已停止", dotClass: "bg-[#6a6a6a]", textClass: "text-[#8a8a8a]", running: false };
  }
}

/** 第二行：最新一句活动或结果，单行。没有时用状态字。 */
export function subtaskDetail(attention: Attention): string {
  return attention.preview?.replace(/\s+/g, " ").trim() ?? "";
}
