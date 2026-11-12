import { Component, createElement, type ReactNode } from "react";

type Props = { resetKey: string; children: ReactNode };
type State = { error: boolean; resetKey: string };

/** 一条坏事件只挡住这一条会话。换会话后重新渲染。 */
export class ChatErrorBoundary extends Component<Props, State> {
  state: State = { error: false, resetKey: "" };

  static getDerivedStateFromError(): Partial<State> {
    return { error: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { error: false, resetKey: props.resetKey };
    return null;
  }

  render() {
    if (this.state.error) {
      return createElement(
        "div",
        {
          "data-chat-error": "",
          className: "flex min-h-0 flex-1 items-center justify-center px-6",
        },
        createElement("p", { className: "text-sm text-wb-fg-2" }, "这条会话暂时无法显示。"),
      );
    }
    return this.props.children;
  }
}
