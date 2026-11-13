# 发布 Windows 安装包与更新源

本文档描述从「云端开发完成」到「用户侧一键更新」的完整发布流程。

## 0. 关键约束

- **Windows 安装包必须在 Windows 上构建**（NSIS 依赖 Windows 工具链）。本仓库日常开发在 Linux 云主机进行，构建请使用 Windows runner：GitHub Actions `windows-latest`（工作流已备好，见 `.github/workflows/release-windows.yml`）或 Cursor 私有 Windows worker。
- 版本号三处保持一致：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`。
- 更新签名为 **minisign**（Tauri updater 内置）。**私钥绝不入库**：公钥已内嵌 `tauri.conf.json → plugins.updater.pubkey`；私钥由发布者保管（本仓库对应私钥存放于云端交付物 `/opt/cursor/artifacts/tauri-signing/ai-workbench.key`，空密码；请转存到 Windows 构建机的安全位置/CI Secret 后妥善保管）。

## 1. 在 Windows runner 上构建

```powershell
pnpm install --frozen-lockfile
$env:TAURI_SIGNING_PRIVATE_KEY = "<私钥内容，或私钥文件路径>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<私钥密码，本项目为空字符串可省略>"
pnpm tauri:build
```

`pnpm tauri:build` 会先编译 `aiwb-daemon` sidecar，再打包并将当前版本的安装包复制到仓库 `release/`，同时删掉该目录里其它版本的安装包（本地未设置 `TAURI_SIGNING_PRIVATE_KEY` 时自动跳过自动更新签名）。原始产物仍在 `target/release/bundle/nsis/`，`release/` 只留最新一份；`latest.json` 与本说明保留。安装包已在 `.gitignore` 中，不会入库。

| 文件 | 用途 |
| --- | --- |
| `AI Workbench_<version>_x64-setup.exe` | 给用户分发的安装包。Tauri 2 默认也把它当作 **更新包** |
| `AI Workbench_<version>_x64-setup.exe.sig` | 上述安装包的 minisign 签名 |
| `AI Workbench_<version>_x64-setup.nsis.zip`（及 `.sig`） | 仅当 `createUpdaterArtifacts` 为 `"v1Compatible"` 时生成的旧更新包 |

> 文件名由 `productName`、`version`、架构决定（本机构建保留空格：`AI Workbench_0.2.0_x64-setup.exe`）。MSI 在 `bundle/msi/`，只用于手动安装。当前 Tauri 2 默认的 updater 下载对象是 **NSIS 的 `.exe`**（签名为同名 `.exe.sig`）；插件仍兼容旧的 `.nsis.zip`。

## 2. 生成更新清单 latest.json

构建完成后在仓库根目录执行：

```powershell
node scripts/gen-latest-json.mjs --url "https://example.com/releases/download/v<version>" --notes "更新说明"
```

脚本自动读取 `tauri.conf.json` 的版本号、在 NSIS 产物目录找到已签名的 `.exe`（或旧的 `.nsis.zip`）与 `.sig`，生成 `release/latest.json`：

```json
{
  "version": "0.1.1",
  "notes": "更新说明",
  "pub_date": "2026-10-10T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<.sig 文件内容>",
      "url": "https://example.com/releases/download/v0.1.1/AI%20Workbench_0.1.1_x64-setup.exe"
    }
  }
}
```

字段要求（Tauri updater 协议）：
- `version`：必须**高于**用户已装版本（semver 比较），否则不提示更新；
- `platforms.windows-x86_64.url`：指向与 `.sig` 对应的文件（当前构建是 **`-setup.exe`**）；
- `signature`：该 zip 的 minisign 签名（`.sig` 文件全文）；
- `notes` / `pub_date`：展示用，可选但建议保留。

## 3. 发布更新源

当前提交没有更新地址：`tauri.conf.json` 的 `endpoints` 为空，`src/lib/update-source.ts` 的 `UPDATE_ENDPOINT` 也是空字符串。检查更新显示「暂无可用更新源」，不会请求占位地址。

有公开的 HTTPS `latest.json` 之后，把这两处写成同一个地址，然后：

1. 在托管处发布该版本（GitHub Release 的 tag 用 `v<version>`，或任意 HTTPS 静态目录）；
2. 上传 `latest.json`、`-setup.exe`、`.exe.sig`（若使用 v1 兼容包，再加 `.nsis.zip` 与其 `.sig`）；
3. 若用 GitHub Release，把它标为 Latest release。用户下次启动应用即收到更新提示。

## 4. GitHub Actions（已备好）

`.github/workflows/release-windows.yml`：推送 `v*` tag 或手动触发即可自动完成「构建 → 签名 → 生成 latest.json → 上传 Release」。需要先在仓库 Secrets 配置：

| Secret | 内容 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件全文（`ai-workbench.key` 的内容） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（本项目为空，可不配置） |

## 5. 发布检查单

- [ ] 三处版本号一致并已 bump
- [ ] `tauri.conf.json` endpoints 指向真实更新源
- [ ] Windows runner 构建通过，产物含 `-setup.exe` 与 `.exe.sig`
- [ ] `latest.json` 的 version 高于线上版本、url/signature 与产物一致
- [ ] 用上一版本安装包实测「检查更新 → 立即更新 → 重启后为新版本」
