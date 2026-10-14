import { SettingsView } from "./settings/SettingsView";
import { useRightPane } from "./use-right-pane";
import { Workspace } from "./Workspace";

export function RightPane() {
  const screen = useRightPane();
  if (screen === "settings") return <SettingsView />;
  return <Workspace />;
}
