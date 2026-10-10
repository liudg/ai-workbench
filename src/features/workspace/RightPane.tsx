import { useWorkbench } from "@/store";
import { SettingsView } from "./settings/SettingsView";
import { Workspace } from "./Workspace";

export function RightPane() {
  const screen = useWorkbench((s) => s.screen);
  if (screen === "settings") return <SettingsView />;
  return <Workspace />;
}
