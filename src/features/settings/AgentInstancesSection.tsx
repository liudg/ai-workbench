import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { agentsApi } from "@/features/agents";
import { findCatalogProbe } from "@/lib/agents";
import { userFacingMessage } from "@/lib/user-facing";
import type {
  AgentCapabilities,
  AgentInstance,
  AgentKind,
  CatalogProbe,
} from "@/types";
import {
  ISOLATION_LABELS,
  builtinDefaultInstance,
  instanceToUpsertInput,
  isDefaultInstanceModified,
} from "./instance-form";
import { InstanceFormDialog } from "./InstanceFormDialog";

export function AgentInstancesSection({
  kind,
  defaultDisplayName,
  capabilities,
  instances,
  probes,
}: {
  kind: AgentKind;
  defaultDisplayName: string;
  capabilities: AgentCapabilities;
  instances: readonly AgentInstance[];
  probes: readonly CatalogProbe[] | undefined;
}) {
  const rows =
    instances.length > 0 ? instances : [builtinDefaultInstance(kind, defaultDisplayName)];

  const [dialogState, setDialogState] = useState<{
    open: boolean;
    editing: AgentInstance | null;
  }>({ open: false, editing: null });
  const [deleting, setDeleting] = useState<AgentInstance | null>(null);
  const [deleteData, setDeleteData] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleToggleEnabled = async (inst: AgentInstance, enabled: boolean) => {
    setBusyId(inst.id);
    setActionError(null);
    try {
      await agentsApi.upsertInstance(instanceToUpsertInput(inst, enabled));
    } catch (err) {
      setActionError(userFacingMessage(err) ?? "更新实例状态失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleResetDefault = async (inst: AgentInstance) => {
    setBusyId(inst.id);
    setActionError(null);
    try {
      await agentsApi.resetDefaultInstance(inst.kind);
    } catch (err) {
      setActionError(userFacingMessage(err) ?? "恢复默认配置失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    setActionError(null);
    try {
      await agentsApi.removeInstance(deleting.id, deleteData);
      setDeleting(null);
      setDeleteData(false);
    } catch (err) {
      setActionError(userFacingMessage(err) ?? "删除实例失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      data-agent-instances={kind}
      className="mt-3 border-t border-wb-border pt-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-wb-fg-2">实例与隔离配置</span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-instance-create={kind}
          onClick={() => setDialogState({ open: true, editing: null })}
        >
          <Plus className="h-3 w-3" />
          新建实例
        </Button>
      </div>

      {actionError ? (
        <p role="alert" className="mt-2 text-xs text-wb-danger">
          {actionError}
        </p>
      ) : null}

      <ul className="mt-2 space-y-1.5">
        {rows.map((inst) => {
          const busy = busyId === inst.id;
          const modifiedDefault = isDefaultInstanceModified(inst, defaultDisplayName);
          const probe = !inst.isDefault ? findCatalogProbe(probes, inst.kind, inst.id) : undefined;
          return (
            <li
              key={inst.id}
              data-instance-row={inst.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-wb-border bg-wb-surface/70 px-3 py-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {inst.accentColor ? (
                    <span
                      data-instance-color-dot={inst.id}
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: inst.accentColor }}
                    />
                  ) : null}
                  <span className="truncate font-medium text-wb-fg">{inst.displayName}</span>
                  {inst.isDefault ? (
                    <span className="rounded bg-wb-hover px-1.5 py-0.5 text-[11px] text-wb-fg-3">
                      默认
                    </span>
                  ) : null}
                  <span
                    data-instance-isolation-badge={inst.isolationMode}
                    className="rounded border border-wb-border bg-wb-elev px-1.5 py-0.5 text-[11px] text-wb-fg-2"
                  >
                    {ISOLATION_LABELS[inst.isolationMode]}
                  </span>
                </div>
                {probe?.status === "failed" ? (
                  <p className="mt-1 break-words text-[11px] text-wb-danger">
                    未就绪：{probe.error ?? "没有读到模型列表"}
                  </p>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  size="sm"
                  data-instance-enabled={inst.id}
                  aria-label={`启用 ${inst.displayName}`}
                  checked={inst.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) => void handleToggleEnabled(inst, checked)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-instance-edit={inst.id}
                  disabled={busy}
                  onClick={() => setDialogState({ open: true, editing: inst })}
                >
                  编辑
                </Button>
                {inst.isDefault && modifiedDefault ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-instance-reset={inst.id}
                    disabled={busy}
                    onClick={() => void handleResetDefault(inst)}
                  >
                    恢复默认
                  </Button>
                ) : null}
                {!inst.isDefault ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-instance-delete={inst.id}
                    disabled={busy}
                    className="text-wb-danger hover:text-wb-danger"
                    onClick={() => {
                      setDeleteData(false);
                      setDeleting(inst);
                    }}
                  >
                    删除
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <InstanceFormDialog
        open={dialogState.open}
        kind={kind}
        agentLabel={defaultDisplayName}
        instance={dialogState.editing}
        capabilities={capabilities}
        onClose={() => setDialogState({ open: false, editing: null })}
        onSubmit={(input) => agentsApi.upsertInstance(input)}
      />

      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !busyId) {
            setDeleting(null);
            setDeleteData(false);
          }
        }}
      >
        <DialogContent data-instance-delete-dialog="">
          <DialogHeader>
            <DialogTitle>删除实例「{deleting?.displayName}」</DialogTitle>
            <DialogDescription>
              删除后已有历史会话记录仍会保留，新建会话将不再列出此实例。
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-wb-border bg-wb-elev px-3 py-2.5 text-xs text-wb-fg">
            <input
              type="checkbox"
              data-instance-delete-data=""
              checked={deleteData}
              disabled={Boolean(busyId)}
              onChange={(event) => setDeleteData(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-wb-border-strong accent-[var(--wb-accent)]"
            />
            <span>同时删除托管目录数据</span>
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={Boolean(busyId)}
              onClick={() => {
                setDeleting(null);
                setDeleteData(false);
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-instance-delete-confirm=""
              disabled={Boolean(busyId)}
              onClick={() => void handleConfirmDelete()}
            >
              {busyId ? "删除中…" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
