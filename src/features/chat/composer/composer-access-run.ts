import type { AgentModelOption } from "@/types";
import { FAST_TIER_ID, tuningForModel } from "./model-picker";
import { addWritableRoot, removeWritableRoot, selectPreset, selectProfile, setNetwork } from "./access";
import { pickWritableDirectory } from "./composer-backend";
import type { ComposerRun } from "./composer-run";

export function addComposerDir(run: ComposerRun) {
  void pickWritableDirectory().then((path) => {
    if (!path) return;
    run.actions.setSandbox(run.sessionId, addWritableRoot(run.sandbox, path, run.projectPath));
  });
}

export function removeComposerDir(run: ComposerRun, path: string) {
  run.actions.setSandbox(run.sessionId, removeWritableRoot(run.sandbox, path));
}

export function selectComposerPreset(run: ComposerRun, mode: Parameters<typeof selectPreset>[1]) {
  run.actions.setSandbox(run.sessionId, selectPreset(run.sandbox, mode));
}

export function selectComposerProfile(run: ComposerRun, id: string) {
  run.actions.setSandbox(run.sessionId, selectProfile(run.sandbox, id));
}

export function setComposerNetwork(run: ComposerRun, enabled: boolean) {
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
  if (!model || !run.view.fastAvailable) return;
  run.actions.setTuning(
    run.sessionId,
    model.id,
    run.view.selectedEffort ?? model.default_effort,
    enabled ? FAST_TIER_ID : null,
  );
}

export function resetComposerTuning(run: ComposerRun) {
  const modelId = run.view.baselineModelId;
  if (!modelId) return;
  run.actions.setTuning(run.sessionId, modelId, run.view.baselineEffort ?? "", run.view.baselineServiceTier);
}
