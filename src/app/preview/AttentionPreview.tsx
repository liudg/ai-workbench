import { useEffect } from "react";

import { CommandMenuHost, OPEN_COMMAND_MENU } from "@/features/command-menu";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { Sidebar } from "@/features/sidebar";

import { useAttentionPreview } from "./use-attention-preview";

/** 开发预览：`?preview=attention`。`menu=1` 打开命令菜单。 */
export default function AttentionPreview() {
  const { session, events } = useAttentionPreview();
  const openMenu = new URLSearchParams(window.location.search).get("menu") === "1";
  useEffect(() => {
    if (!openMenu) return;
    window.dispatchEvent(new Event(OPEN_COMMAND_MENU));
  }, [openMenu]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <ChatView session={session} events={events} />
      </main>
      <CommandMenuHost />
    </div>
  );
}
