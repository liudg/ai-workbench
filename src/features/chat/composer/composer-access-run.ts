import type { AgentModelOption, SessionSandbox } from "@/types";
import { fastTier, tuningForModel } from "./model-picker";
import { addWritableRoot, removeWritableRoot, selectPreset, selectProfile, setNetwork } from "./access";
import { pickWritableDirectory } from "./composer-backend";
import type { ComposerRun } from "./composer-run";

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
  void pickWritableDirectory().then((path) => {
    if (!path) return;
    run.actions.setSandbox(run.sessionId, addWritableRoot(sandbox, path, run.projectPath));
  });
}

export function removeComposerDir(run: ComposerRun, path: string) {
  if (!run.sandbox) return;
  run.actions.setSandbox(run.sessionId, removeWritableRoot(run.sandbox, path));
}

export function selectComposerPreset(run: ComposerRun, mode: Parameters<typeof selectPreset>[1]) {
  run.actions.setSandbox(run.sessionId, selectPreset(sandboxOrBlank(run, mode), mode));
}

export function selectComposerProfile(run: ComposerRun, id: string) {
  run.actions.setSandbox(run.sessionId, selectProfile(sandboxOrBlank(run), id));
}

export function setComposerNetwork(run: ComposerRun, enabled: boolean) {
  if (!run.sandbox) return;
  run.actions.setSandbox(run.sessionId, setNetwork(run.sandbox, enabled));
}

export function chooseComposerModel(run: ComposerRun, model: AgentModelOption) {
  const next = tuningForModel(model, run.view.selectedEffort, run.view.storedServiceTier);
  run.actions.setTuning(run.sessionId, next.model, next.effort, next.serviceTier);
}

export function chooseComposerEffort(run: ComposerRun, effort: string) {
  if (!run.view.selectedModel) return;
  run.actions.setTuning(run.sessionId, run.view.selectedModel.id, effort);
}

export function chooseComposerFast(run: ComposerRun, enabled: boolean) {
  const model = run.view.selectedModel;
  const tier = fastTier(model);
  if (!model || !tier) return;
  run.actions.setTuning(
    run.sessionId,
    model.id,
    run.view.selectedEffort ?? model.default_effort,
    enabled ? tier.id : null,
  );
}

export function resetComposerTuning(run: ComposerRun) {
  const modelId = run.view.baselineModelId;
  if (!modelId) return;
  run.actions.setTuning(run.sessionId, modelId, run.view.baselineEffort ?? "", run.view.baselineServiceTier);
}
