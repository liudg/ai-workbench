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
pnpm tauri build
```

产物位于 `src-tauri/target/release/bundle/nsis/`：

| 文件 | 用途 |
| --- | --- |
| `AI Workbench_<version>_x64-setup.exe` | 给用户分发的安装包。Tauri 2 默认也把它当作 **更新包** |
| `AI Workbench_<version>_x64-setup.exe.sig` | 上述安装包的 minisign 签名 |
| `AI Workbench_<version>_x64-setup.nsis.zip`（及 `.sig`） | 仅当 `createUpdaterArtifacts` 为 `"v1Compatible"` 时生成的旧更新包 |

> 文件名由 `productName`、`version`、架构决定（本机构建保留空格：`AI Workbench_0.1.4_x64-setup.exe`）。MSI 在 `bundle/msi/`，只用于手动安装。当前 Tauri 2 默认的 updater 下载对象是 **NSIS 的 `.exe`**（签名为同名 `.exe.sig`）；插件仍兼容旧的 `.nsis.zip`。

## 2. 生成更新清单 latest.json

构建完成后在仓库根目录执行：

```powershell
node scripts/gen-latest-json.mjs --url "https://github.com/<OWNER>/<REPO>/releases/download/v<version>" --notes "更新说明"
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
      "url": "https://github.com/<OWNER>/<REPO>/releases/download/v0.1.1/AI%20Workbench_0.1.1_x64-setup.exe"
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

应用启动时与「检查更新」会请求 `tauri.conf.json → plugins.updater.endpoints` 的第一个可用 URL，当前为：

```
https://github.com/OWNER/REPO/releases/latest/download/latest.json
```

发布时把 `OWNER/REPO` 替换为实际仓库（同时改 `tauri.conf.json` 的 endpoints），然后：

1. 在 GitHub 创建 Release（tag `v<version>`）；
2. 上传 `latest.json`、`-setup.exe`、`.exe.sig`（若使用 v1 兼容包，再加 `.nsis.zip` 与其 `.sig`）；
3. 标记为 Latest release。用户下次启动应用即收到更新提示。

不使用 GitHub 时，`latest.json` 与安装包放到任何 HTTPS 静态托管均可（保持 endpoints 指向它）。

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
