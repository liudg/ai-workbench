# 发布 Windows 安装包与自动更新

本文档说明基于 GitHub Actions + GitHub Releases 的完整发版与自动更新流程。

## 0. 关键约束

- **四处版本号一致**：`package.json`、`Cargo.toml`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 必须保持一致（由 `scripts/check-release-version.mjs` 自动校验）。
- **更新签名（minisign）**：公钥已内嵌于 `src-tauri/tauri.conf.json → plugins.updater.pubkey`；私钥绝不入库，配置在 GitHub 仓库 Actions Secret `TAURI_SIGNING_PRIVATE_KEY` 中。
- **更新源地址**：`src-tauri/tauri.conf.json → plugins.updater.endpoints` 与 `src/lib/native/update-source.ts → UPDATE_ENDPOINT` 统一指向：
  `https://github.com/liudg/ai-workbench/releases/latest/download/latest.json`

## 1. 日常发版步骤（推送 tag 触发）

1. 修改上述四处版本号（如升到 `0.2.88`），运行校验并提交推送到主分支：
   ```powershell
   node scripts/check-release-version.mjs
   git add -A
   git commit -m "chore: bump to 0.2.88"
   git push
   ```
2. 打 `v<version>` tag 并推送，自动触发 `.github/workflows/release-windows.yml`：
   ```powershell
   git tag v0.2.88
   git push origin v0.2.88
   ```
   > 若希望自定义本次弹窗里展示的更新说明，可使用带注释的 tag：`git tag -a v0.2.88 -m "更新内容..."`；若使用轻量 tag，脚本会自动提取自上一个 `v*` tag 以来的提交记录。

3. GitHub Actions（`windows-latest`）会自动执行：
   - 校验四处版本号、tag 一致性、更新源配置以及 `TAURI_SIGNING_PRIVATE_KEY`；
   - 编译 `aiwb-daemon` sidecar 与签名的 NSIS 安装包；
   - 将产物整理到 `release/`（空格规范化为连字符：`AI-Workbench_<version>_x64-setup.exe` 及 `.sig`），并生成 `release/latest.json`；
   - 创建对应的 GitHub Release 并上传 `AI-Workbench_<version>_x64-setup.exe`、`.exe.sig` 和 `latest.json`。

## 2. 本地手动打包

```powershell
pnpm install --frozen-lockfile
# 本地测试打包可不设私钥（会自动跳过 updater 签名）；正式签名包需设置私钥：
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$HOME\.tauri\ai-workbench.key"
pnpm tauri:build --bundles nsis
node scripts/gen-latest-json.mjs --url "https://github.com/liudg/ai-workbench/releases/download/v<version>"
```

| `release/` 产物 | 用途 |
| --- | --- |
| `AI-Workbench_<version>_x64-setup.exe` | 分发给用户的安装包，同时也是 Tauri 2 updater 下载的更新包 |
| `AI-Workbench_<version>_x64-setup.exe.sig` | 上述安装包的 minisign 签名 |
| `latest.json` | Tauri updater 读取的版本清单（`version`、`notes`、`pub_date`、`platforms.windows-x86_64`） |

## 3. GitHub 仓库 Secrets

| Secret | 内容 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 必填，Tauri 签名私钥全文（`ai-workbench.key` 内容） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 可选，私钥密码（无密码密钥留空即可） |

## 4. 发布检查单

- [ ] 四处版本号一致且高于上一个已发布版本（`node scripts/check-release-version.mjs` 通过）
- [ ] GitHub Actions `release-windows` 工作流运行成功
- [ ] 最新 GitHub Release 中包含 `AI-Workbench_<version>_x64-setup.exe`、`.exe.sig` 与 `latest.json`
- [ ] 旧版本客户端点击「检查更新 → 立即更新」可正常下载、安装并重启到新版本
