import { pickFolder } from "@/lib/native/pick-folder";
import type { AgentModelOption, SessionSandbox } from "@/types";
import { addWritableRoot, removeWritableRoot, selectPreset, selectProfile, setNetwork } from "./access";
import type { ComposerRun } from "./composer-run";
import { fastTier, tuningForModel } from "./model-picker";

function sandboxOrBlank(run: ComposerRun, mode: SessionSandbox["mode"] = "ask"): SessionSandbox {
  return (
    run.sandbox ?? {
      mode,
      networkAccess: false,
      writableRoots: [],
      profileId: "",
    }
  );
}

export function addComposerDir(run: ComposerRun) {
  const sandbox = run.sandbox;
  if (!sandbox) return;
  void pickFolder("添加可写目录").then((path) => {
    if (!path) return;
    run.host.setSandbox(addWritableRoot(sandbox, path, run.host.projectPath));
  });
}

export function removeComposerDir(run: ComposerRun, path: string) {
  if (!run.sandbox) return;
  run.host.setSandbox(removeWritableRoot(run.sandbox, path));
}

export function selectComposerPreset(run: ComposerRun, mode: Parameters<typeof selectPreset>[1]) {
  run.host.setSandbox(selectPreset(sandboxOrBlank(run, mode), mode));
}

export function selectComposerProfile(run: ComposerRun, id: string) {
  run.host.setSandbox(selectProfile(sandboxOrBlank(run), id));
}

export function setComposerNetwork(run: ComposerRun, enabled: boolean) {
  if (!run.sandbox) return;
  run.host.setSandbox(setNetwork(run.sandbox, enabled));
}

export function chooseComposerModel(run: ComposerRun, model: AgentModelOption) {
  const next = tuningForModel(model, run.view.selectedEffort, run.view.storedServiceTier);
  run.host.setTuning(next.model, next.effort, next.serviceTier);
}

export function chooseComposerEffort(run: ComposerRun, effort: string) {
  if (!run.view.selectedModel) return;
  run.host.setTuning(run.view.selectedModel.id, effort);
}

export function chooseComposerFast(run: ComposerRun, enabled: boolean) {
  const model = run.view.selectedModel;
  const tier = fastTier(model);
  if (!model || !tier) return;
  run.host.setTuning(
    model.id,
    run.view.selectedEffort ?? model.default_effort,
    enabled ? tier.id : null,
  );
}

export function resetComposerTuning(run: ComposerRun) {
  const modelId = run.view.baselineModelId;
  if (!modelId) return;
  run.host.setTuning(modelId, run.view.baselineEffort ?? "", run.view.baselineServiceTier);
}
