//! `aiwb` 命令行启动脚本管理。
//!
//! - Windows：在 `<app_data_dir>\bin` 下写入 `aiwb.ps1`（PowerShell）、`aiwb.cmd`（cmd）和 `aiwb`（Git Bash / WSL），
//!   并把 `<app_data_dir>\bin` 追加进 `HKCU\Environment\Path`（保留 `REG_EXPAND_SZ` 中的未展开 `%VAR%`），广播 `WM_SETTINGCHANGE`。
//! - macOS / Linux：在 `<app_data_dir>/bin/aiwb` 生成可执行 POSIX 脚本，软链接到 `~/.local/bin/aiwb`。
//! - 卸载与覆盖前均校验 [`SHIM_MARKER`]，绝不误删非 AI Workbench 创建的外部同名命令。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const SHIM_MARKER: &str = "ai-workbench-cli-shim";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCommandStatus {
    pub supported: bool,
    pub installed: bool,
    pub shim_path: Option<String>,
    pub on_path: bool,
}

#[tauri::command]
pub fn cli_command_status(app: AppHandle) -> Result<CliCommandStatus, String> {
    let paths = resolve_shim_paths(&app)?;
    Ok(compute_status(&paths))
}

#[tauri::command]
pub async fn install_cli_command(app: AppHandle) -> Result<CliCommandStatus, String> {
    let paths = resolve_shim_paths(&app)?;
    let exe = std::env::current_exe().map_err(|e| format!("无法定位当前应用可执行文件：{e}"))?;
    let exe = PathBuf::from(aiwb_core::models::strip_verbatim_prefix(
        &exe.to_string_lossy(),
    ));
    tauri::async_runtime::spawn_blocking(move || install_blocking(&paths, &exe))
        .await
        .map_err(|e| format!("安装命令行工具失败：{e}"))?
}

#[tauri::command]
pub async fn uninstall_cli_command(app: AppHandle) -> Result<CliCommandStatus, String> {
    let paths = resolve_shim_paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || uninstall_blocking(&paths))
        .await
        .map_err(|e| format!("卸载命令行工具失败：{e}"))?
}

#[derive(Debug, Clone)]
struct ShimPaths {
    bin_dir: PathBuf,
    posix_shim: PathBuf,
    #[cfg(windows)]
    cmd_shim: PathBuf,
    #[cfg(windows)]
    ps1_shim: PathBuf,
    #[cfg(unix)]
    unix_link: PathBuf,
}

fn resolve_shim_paths(app: &AppHandle) -> Result<ShimPaths, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    let bin_dir = data_dir.join("bin");
    let posix_shim = bin_dir.join("aiwb");
    #[cfg(windows)]
    {
        let cmd_shim = bin_dir.join("aiwb.cmd");
        let ps1_shim = bin_dir.join("aiwb.ps1");
        Ok(ShimPaths {
            bin_dir,
            posix_shim,
            cmd_shim,
            ps1_shim,
        })
    }
    #[cfg(unix)]
    {
        let home = app
            .path()
            .home_dir()
            .map_err(|e| format!("无法定位用户主目录：{e}"))?;
        let unix_link = home.join(".local").join("bin").join("aiwb");
        Ok(ShimPaths {
            bin_dir,
            posix_shim,
            unix_link,
        })
    }
}

fn compute_status(paths: &ShimPaths) -> CliCommandStatus {
    #[cfg(windows)]
    {
        let installed = file_has_marker(&paths.cmd_shim) && file_has_marker(&paths.ps1_shim);
        let on_path = windows_dir_on_user_or_process_path(&paths.bin_dir);
        CliCommandStatus {
            supported: true,
            installed,
            shim_path: Some(paths.cmd_shim.to_string_lossy().into_owned()),
            on_path,
        }
    }
    #[cfg(unix)]
    {
        let installed = unix_link_owned_by_us(&paths.unix_link, &paths.posix_shim)
            && file_has_marker(&paths.posix_shim);
        let link_dir = paths
            .unix_link
            .parent()
            .unwrap_or_else(|| Path::new("/usr/local/bin"));
        let on_path = process_path_contains(link_dir);
        CliCommandStatus {
            supported: true,
            installed,
            shim_path: Some(paths.unix_link.to_string_lossy().into_owned()),
            on_path,
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = paths;
        CliCommandStatus {
            supported: false,
            installed: false,
            shim_path: None,
            on_path: false,
        }
    }
}

fn install_blocking(paths: &ShimPaths, exe: &Path) -> Result<CliCommandStatus, String> {
    std::fs::create_dir_all(&paths.bin_dir)
        .map_err(|e| format!("创建目录失败 {}：{e}", paths.bin_dir.display()))?;

    ensure_not_foreign_file(&paths.posix_shim)?;
    let posix_content = render_posix_shim(exe);
    std::fs::write(&paths.posix_shim, posix_content.as_bytes())
        .map_err(|e| format!("写入脚本失败 {}：{e}", paths.posix_shim.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&paths.posix_shim, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("设置可执行权限失败 {}：{e}", paths.posix_shim.display()))?;

        let link_parent = paths
            .unix_link
            .parent()
            .ok_or_else(|| "无效的目标链接路径".to_string())?;
        std::fs::create_dir_all(link_parent)
            .map_err(|e| format!("创建目录失败 {}：{e}", link_parent.display()))?;

        if paths.unix_link.symlink_metadata().is_ok() {
            if !unix_link_owned_by_us(&paths.unix_link, &paths.posix_shim) {
                return Err(format!(
                    "已存在非 AI Workbench 创建的同名命令：{}",
                    paths.unix_link.display()
                ));
            }
            std::fs::remove_file(&paths.unix_link)
                .map_err(|e| format!("更新软链接失败 {}：{e}", paths.unix_link.display()))?;
        }
        std::os::unix::fs::symlink(&paths.posix_shim, &paths.unix_link)
            .map_err(|e| format!("创建软链接失败 {}：{e}", paths.unix_link.display()))?;
    }

    #[cfg(windows)]
    {
        ensure_not_foreign_file(&paths.cmd_shim)?;
        ensure_not_foreign_file(&paths.ps1_shim)?;
        let cmd_content = render_windows_cmd_shim(exe);
        std::fs::write(&paths.cmd_shim, cmd_content.as_bytes())
            .map_err(|e| format!("写入脚本失败 {}：{e}", paths.cmd_shim.display()))?;
        let ps1_content = render_windows_ps1_shim(exe);
        std::fs::write(&paths.ps1_shim, ps1_content.as_bytes())
            .map_err(|e| format!("写入脚本失败 {}：{e}", paths.ps1_shim.display()))?;
        windows_add_to_user_path(&paths.bin_dir)?;
    }

    Ok(compute_status(paths))
}

fn uninstall_blocking(paths: &ShimPaths) -> Result<CliCommandStatus, String> {
    #[cfg(unix)]
    {
        if paths.unix_link.symlink_metadata().is_ok() {
            if !unix_link_owned_by_us(&paths.unix_link, &paths.posix_shim) {
                return Err(format!(
                    "已存在非 AI Workbench 创建的同名命令，已跳过删除：{}",
                    paths.unix_link.display()
                ));
            }
            std::fs::remove_file(&paths.unix_link)
                .map_err(|e| format!("移除软链接失败 {}：{e}", paths.unix_link.display()))?;
        }
    }

    #[cfg(windows)]
    {
        remove_if_owned(&paths.cmd_shim)?;
        remove_if_owned(&paths.ps1_shim)?;
        windows_remove_from_user_path(&paths.bin_dir)?;
    }

    remove_if_owned(&paths.posix_shim)?;

    if let Ok(mut entries) = std::fs::read_dir(&paths.bin_dir) {
        if entries.next().is_none() {
            let _ = std::fs::remove_dir(&paths.bin_dir);
        }
    }

    Ok(compute_status(paths))
}

fn file_has_marker(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|content| content.contains(SHIM_MARKER))
}

fn ensure_not_foreign_file(path: &Path) -> Result<(), String> {
    if path.symlink_metadata().is_ok() && !file_has_marker(path) {
        return Err(format!(
            "已存在非 AI Workbench 创建的同名文件：{}",
            path.display()
        ));
    }
    Ok(())
}

fn remove_if_owned(path: &Path) -> Result<(), String> {
    if path.symlink_metadata().is_err() {
        return Ok(());
    }
    if !file_has_marker(path) {
        return Err(format!(
            "检测到非 AI Workbench 创建的文件，拒绝删除：{}",
            path.display()
        ));
    }
    std::fs::remove_file(path).map_err(|e| format!("删除文件失败 {}：{e}", path.display()))
}

#[cfg(unix)]
fn unix_link_owned_by_us(link_path: &Path, expected_shim: &Path) -> bool {
    let Ok(meta) = link_path.symlink_metadata() else {
        return false;
    };
    if meta.file_type().is_symlink() {
        if let Ok(target) = std::fs::read_link(link_path) {
            if target == expected_shim {
                return true;
            }
            if file_has_marker(&target) {
                return true;
            }
        }
        return false;
    }
    meta.is_file() && file_has_marker(link_path)
}

fn powershell_string_expr(value: &str) -> String {
    if value.is_ascii() {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        let mut parts = Vec::new();
        let mut ascii_buf = String::new();
        for ch in value.chars() {
            if ch.is_ascii() {
                ascii_buf.push(ch);
            } else {
                if !ascii_buf.is_empty() {
                    parts.push(format!("'{}'", ascii_buf.replace('\'', "''")));
                    ascii_buf.clear();
                }
                for unit in ch.encode_utf16(&mut [0u16; 2]) {
                    parts.push(format!("[char]0x{unit:04X}"));
                }
            }
        }
        if !ascii_buf.is_empty() {
            parts.push(format!("'{}'", ascii_buf.replace('\'', "''")));
        }
        if parts.is_empty() {
            "''".to_string()
        } else {
            format!("({})", parts.join("+"))
        }
    }
}

pub fn render_windows_ps1_shim(exe: &Path) -> String {
    let exe_expr = powershell_string_expr(&exe.to_string_lossy());
    format!(
        "# {SHIM_MARKER}\r\n\
$exe = {exe_expr}\r\n\
if ($args.Count -eq 0) {{\r\n\
  Start-Process -FilePath $exe\r\n\
}} else {{\r\n\
  $qa = @(foreach ($x in $args) {{\r\n\
    '\"' + ([regex]::Replace([string]$x, '(\\*)\"', '$1$1\\\"') -replace '(\\\\+)$', '$1$1') + '\"'\r\n\
  }})\r\n\
  Start-Process -FilePath $exe -ArgumentList $qa\r\n\
}}\r\n"
    )
}

pub fn render_windows_cmd_shim(exe: &Path) -> String {
    let exe_expr = powershell_string_expr(&exe.to_string_lossy());
    // Single-line PowerShell script with zero `"`, `!`, or `%` characters so `cmd.exe` passes it verbatim.
    let ps_cmd = format!(
        "$q = [string][char]34; \
$exe = {exe_expr}; \
$cl = [string]$env:AIWB_CMDLINE; \
$parsed = $null; \
if ($cl -match '^\\s*(?:\\x22[^\\x22]*\\x22|\\S+)(?:\\s+/[a-zA-Z0-9:+-]+)*?\\s+/[cCkK]\\s*(.*)$') {{ \
  $rest = $Matches[1].Trim(); \
  $qc = ([regex]::Matches($rest, $q)).Count; \
  if ($rest.StartsWith($q) -and $rest.EndsWith($q) -and ($rest.StartsWith($q + $q) -or $qc -gt 2)) {{ \
    $rest = $rest.Substring(1, $rest.Length - 2); \
  }} \
  $ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'AiwbWin32'), [Reflection.Emit.AssemblyBuilderAccess]::Run); \
  $mb = $ab.DefineDynamicModule('m'); \
  $tb = $mb.DefineType('N', 'Public,Abstract,Sealed'); \
  $pm = $tb.DefinePInvokeMethod('CommandLineToArgvW', 'shell32.dll', 'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, [IntPtr], @([string], [int].MakeByRefType()), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode); \
  $pm.SetImplementationFlags('PreserveSig'); \
  $fm = $tb.DefinePInvokeMethod('LocalFree', 'kernel32.dll', 'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, [IntPtr], @([IntPtr]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode); \
  $fm.SetImplementationFlags('PreserveSig'); \
  $nt = $tb.CreateType(); \
  $n = 0; \
  $ptr = $nt::CommandLineToArgvW($rest, [ref]$n); \
  if ($ptr -ne [IntPtr]::Zero) {{ \
    try {{ \
      $toks = for ($i = 1; $i -lt $n; $i++) {{ \
        $ap = [Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $i * [IntPtr]::Size); \
        [Runtime.InteropServices.Marshal]::PtrToStringUni($ap) \
      }}; \
      $parsed = @($toks); \
    }} finally {{ \
      [void]$nt::LocalFree($ptr); \
    }} \
  }} \
}} \
if ($null -eq $parsed) {{ \
  $cnt = 0; \
  [void][int]::TryParse([string]$env:AIWB_ARGC, [ref]$cnt); \
  $parsed = @(for ($i = 0; $i -lt $cnt; $i++) {{ [Environment]::GetEnvironmentVariable('AIWB_ARG_' + $i) }}); \
}} \
if ($parsed.Count -eq 0) {{ \
  Start-Process -FilePath $exe; \
}} else {{ \
  $qa = @(foreach ($x in $parsed) {{ \
    $q + ([regex]::Replace([string]$x, '(\\*)' + $q, '$1$1\\' + $q) -replace '(\\\\+)$', '$1$1') + $q \
  }}); \
  Start-Process -FilePath $exe -ArgumentList $qa; \
}}"
    );
    debug_assert!(!ps_cmd.contains('"') && !ps_cmd.contains('!') && !ps_cmd.contains('%'));
    format!(
        "@echo off\r\n\
rem {SHIM_MARKER}\r\n\
@setlocal DisableDelayedExpansion\r\n\
set _AIWB_N=0\r\n\
setlocal EnableDelayedExpansion\r\n\
set AIWB_CMDLINE=!CMDCMDLINE!\r\n\
if not \"!AIWB_CMDLINE:/c=!\"==\"!AIWB_CMDLINE!\" goto aiwb_ps\r\n\
if not \"!AIWB_CMDLINE:/k=!\"==\"!AIWB_CMDLINE!\" goto aiwb_ps\r\n\
endlocal\r\n\
:aiwb_loop\r\n\
if \"%~1\"==\"\" goto aiwb_interactive_done\r\n\
set \"_AIWB_V=%~1\"\r\n\
call set \"AIWB_ARG_%%_AIWB_N%%=%%_AIWB_V%%\"\r\n\
set /a _AIWB_N+=1\r\n\
shift\r\n\
goto aiwb_loop\r\n\
:aiwb_interactive_done\r\n\
set \"AIWB_ARGC=%_AIWB_N%\"\r\n\
setlocal EnableDelayedExpansion\r\n\
set AIWB_CMDLINE=!CMDCMDLINE!\r\n\
:aiwb_ps\r\n\
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"{ps_cmd}\"\r\n"
    )
}

pub fn render_posix_shim(exe: &Path) -> String {
    let normalized = if cfg!(windows) {
        exe.to_string_lossy().replace('\\', "/")
    } else {
        exe.to_string_lossy().into_owned()
    };
    let quoted = shell_single_quote(&normalized);
    format!(
        "#!/usr/bin/env sh\n# {SHIM_MARKER}\nEXE={quoted}\nif [ -n \"${{WSL_DISTRO_NAME:-}}\" ] && command -v wslpath >/dev/null 2>&1; then\n  EXE=\"$(wslpath -u \"$EXE\" 2>/dev/null || printf '%s' \"$EXE\")\"\n  for _aiwb_arg in \"$@\"; do\n    shift\n    case \"$_aiwb_arg\" in\n      -*|aiwb://*|AIWB://*) set -- \"$@\" \"$_aiwb_arg\" ;;\n      *)\n        if [ -e \"$_aiwb_arg\" ]; then\n          set -- \"$@\" \"$(wslpath -w \"$_aiwb_arg\" 2>/dev/null || printf '%s' \"$_aiwb_arg\")\"\n        else\n          set -- \"$@\" \"$_aiwb_arg\"\n        fi\n        ;;\n    esac\n  done\nfi\n(\"$EXE\" \"$@\" >/dev/null 2>&1 &)\n"
    )
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn process_path_contains(dir: &Path) -> bool {
    let Some(raw) = std::env::var_os("PATH") else {
        return false;
    };
    let target = path_compare_key(&dir.to_string_lossy());
    std::env::split_paths(&raw)
        .any(|entry| path_compare_key(&entry.to_string_lossy()) == target)
}

pub fn path_compare_key(raw: &str) -> String {
    aiwb_core::models::cwd_key(raw.trim().trim_matches('"'))
}

pub fn append_windows_path_entry(existing: &str, dir_to_add: &str) -> (String, bool) {
    let target_key = path_compare_key(dir_to_add);
    let already_present = existing
        .split(';')
        .filter(|part| !part.trim().is_empty())
        .any(|part| path_compare_key(part) == target_key);
    if already_present {
        return (existing.to_string(), false);
    }
    let clean_dir = dir_to_add.trim().trim_matches('"');
    let trimmed_existing = existing.trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    if trimmed_existing.is_empty() {
        (clean_dir.to_string(), true)
    } else {
        (format!("{trimmed_existing};{clean_dir}"), true)
    }
}

pub fn remove_windows_path_entry(existing: &str, dir_to_remove: &str) -> (String, bool) {
    let target_key = path_compare_key(dir_to_remove);
    let mut kept = Vec::new();
    let mut removed = false;
    for part in existing.split(';') {
        if part.trim().is_empty() {
            continue;
        }
        if path_compare_key(part) == target_key {
            removed = true;
        } else {
            kept.push(part);
        }
    }
    if !removed {
        return (existing.to_string(), false);
    }
    (kept.join(";"), true)
}

#[cfg(windows)]
fn windows_dir_on_user_or_process_path(dir: &Path) -> bool {
    let dir_str = dir.to_string_lossy();
    let target = path_compare_key(&dir_str);
    if let Ok(Some((user_path, _))) = read_hkcu_user_path() {
        if user_path
            .split(';')
            .filter(|part| !part.trim().is_empty())
            .any(|part| path_compare_key(part) == target)
        {
            return true;
        }
    }
    process_path_contains(dir)
}

#[cfg(windows)]
fn read_hkcu_user_path() -> Result<Option<(String, winreg::enums::RegType)>, String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::types::FromRegValue;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(env_key) = hkcu.open_subkey_with_flags("Environment", KEY_READ) else {
        return Ok(None);
    };
    match env_key.get_raw_value("Path") {
        Ok(raw) => {
            let text = String::from_reg_value(&raw)
                .map_err(|e| format!("读取用户 PATH 注册表失败：{e}"))?;
            Ok(Some((text, raw.vtype)))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("读取用户 PATH 注册表失败：{err}")),
    }
}

#[cfg(windows)]
fn write_hkcu_user_path(value: &str, vtype: winreg::enums::RegType) -> Result<(), String> {
    use std::borrow::Cow;
    use winreg::enums::{RegType, HKEY_CURRENT_USER};
    use winreg::{RegKey, RegValue};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (env_key, _) = hkcu
        .create_subkey("Environment")
        .map_err(|e| format!("打开 HKCU\\Environment 失败：{e}"))?;

    let target_type = match vtype {
        RegType::REG_SZ | RegType::REG_EXPAND_SZ => vtype,
        _ => RegType::REG_EXPAND_SZ,
    };

    let mut utf16: Vec<u16> = value.encode_utf16().collect();
    utf16.push(0);
    let bytes: Vec<u8> = utf16.into_iter().flat_map(u16::to_le_bytes).collect();
    let reg_val = RegValue {
        bytes: Cow::Owned(bytes),
        vtype: target_type,
    };
    env_key
        .set_raw_value("Path", &reg_val)
        .map_err(|e| format!("写入用户 PATH 注册表失败：{e}"))?;

    broadcast_environment_change();
    Ok(())
}

#[cfg(windows)]
fn windows_add_to_user_path(dir: &Path) -> Result<(), String> {
    use winreg::enums::RegType;

    let (existing, vtype) = read_hkcu_user_path()?
        .unwrap_or_else(|| (String::new(), RegType::REG_EXPAND_SZ));
    let (updated, changed) = append_windows_path_entry(&existing, &dir.to_string_lossy());
    if changed {
        write_hkcu_user_path(&updated, vtype)?;
    }
    Ok(())
}

#[cfg(windows)]
fn windows_remove_from_user_path(dir: &Path) -> Result<(), String> {
    let Some((existing, vtype)) = read_hkcu_user_path()? else {
        return Ok(());
    };
    let (updated, changed) = remove_windows_path_entry(&existing, &dir.to_string_lossy());
    if changed {
        write_hkcu_user_path(&updated, vtype)?;
    }
    Ok(())
}

#[cfg(windows)]
fn broadcast_environment_change() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };

    let mut wide: Vec<u16> = "Environment".encode_utf16().collect();
    wide.push(0);
    unsafe {
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(wide.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            2_000,
            None,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_path_append_and_remove_preserves_unexpanded_env_vars() {
        let original = r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;C:\Tools;";
        let shim_dir = r"C:\Users\dev\AppData\Roaming\com.aiworkbench.app\bin";

        let (added, changed) = append_windows_path_entry(original, shim_dir);
        assert!(changed);
        assert_eq!(
            added,
            r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;C:\Tools;C:\Users\dev\AppData\Roaming\com.aiworkbench.app\bin"
        );

        // 幂等校验（忽略末尾斜杠与大小写）。
        let (again, changed_again) = append_windows_path_entry(
            &added,
            r"C:\Users\dev\AppData\Roaming\com.aiworkbench.app\bin\",
        );
        assert!(!changed_again);
        assert_eq!(again, added);

        let (removed, removed_changed) = remove_windows_path_entry(&added, shim_dir);
        assert!(removed_changed);
        assert_eq!(
            removed,
            r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;C:\Tools"
        );
    }

    #[test]
    fn renders_cmd_ps1_and_posix_shims_with_ownership_marker() {
        let win_exe = Path::new(r"C:\Program Files\AI Workbench\ai-workbench.exe");
        let cmd = render_windows_cmd_shim(win_exe);
        assert!(cmd.contains(SHIM_MARKER));
        assert!(
            !cmd.contains("%*"),
            "cmd shim must never expand %* unquoted"
        );
        assert!(cmd.contains("@setlocal DisableDelayedExpansion"));
        assert!(cmd.contains("setlocal EnableDelayedExpansion"));
        assert!(cmd.contains("set AIWB_CMDLINE=!CMDCMDLINE!"));
        assert!(cmd.contains("CommandLineToArgvW"));
        assert!(cmd.contains("Start-Process -FilePath $exe"));

        let ps1 = render_windows_ps1_shim(win_exe);
        assert!(ps1.contains(SHIM_MARKER));
        assert!(ps1.contains("Start-Process -FilePath $exe"));
        assert!(ps1.contains("-ArgumentList"));

        let sh = render_posix_shim(Path::new("/Applications/AI Workbench.app/Contents/MacOS/ai-workbench"));
        assert!(sh.starts_with("#!/usr/bin/env sh\n"));
        assert!(!sh.contains("\r\n"));
        assert!(sh.contains(SHIM_MARKER));
        assert!(sh.contains("\"$@\""));
    }

    #[cfg(windows)]
    #[test]
    fn windows_cmd_and_ps1_shims_preserve_ampersand_deep_link_without_command_injection() {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        use std::time::{Duration, Instant};

        let dir = std::env::temp_dir().join(format!("aiwb-shim-exec-{}", uuid::Uuid::new_v4()));
        let bin_dir = dir.join("space dir");
        std::fs::create_dir_all(&bin_dir).unwrap();

        let cap_rs = dir.join("capture.rs");
        let cap_exe = bin_dir.join("capture.exe");
        let out_file = dir.join("captured.txt");
        std::fs::write(
            &cap_rs,
            r#"fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = std::env::var("AIWB_CAPTURE_OUT").expect("AIWB_CAPTURE_OUT");
    std::fs::write(out, args.join("\n")).expect("write captured args");
}
"#,
        )
        .unwrap();

        let status = Command::new("rustc")
            .arg(&cap_rs)
            .arg("-o")
            .arg(&cap_exe)
            .status()
            .expect("compile capture.exe with rustc");
        assert!(status.success(), "rustc failed to compile capture.exe");

        let cmd_shim = bin_dir.join("aiwb.cmd");
        let ps1_shim = bin_dir.join("aiwb.ps1");
        std::fs::write(&cmd_shim, render_windows_cmd_shim(&cap_exe)).unwrap();
        std::fs::write(&ps1_shim, render_windows_ps1_shim(&cap_exe)).unwrap();

        let wait_captured = |target: &Path| -> String {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if let Ok(content) = std::fs::read_to_string(target) {
                    if !content.is_empty() {
                        return content;
                    }
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            panic!("timed out waiting for capture.exe output at {}", target.display());
        };

        let url = r"aiwb://open?path=G:\repo&prompt=hello&evil=1";

        // 1) Invoke via `cmd.exe /d /c` with `&evil=1` inside the deep-link argument
        let _ = std::fs::remove_file(&out_file);
        let cmd_out = Command::new("cmd.exe")
            .env("AIWB_CAPTURE_OUT", &out_file)
            .raw_arg(format!(
                "/d /c \"\"{}\" \"{}\"" ,
                cmd_shim.display(),
                url
            ) + "\"")
            .output()
            .expect("invoke cmd.exe /d /c aiwb.cmd");
        let stderr = String::from_utf8_lossy(&cmd_out.stderr);
        assert!(
            cmd_out.status.success() && !stderr.to_ascii_lowercase().contains("evil"),
            "cmd.exe unexpectedly executed or failed on &evil=1: status={:?}, stderr={stderr}",
            cmd_out.status
        );
        assert_eq!(wait_captured(&out_file), url);

        // 2) Invoke `aiwb.ps1` directly via PowerShell
        let _ = std::fs::remove_file(&out_file);
        let ps_out = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&ps1_shim)
            .arg(url)
            .env("AIWB_CAPTURE_OUT", &out_file)
            .output()
            .expect("invoke powershell.exe aiwb.ps1");
        assert!(
            ps_out.status.success(),
            "aiwb.ps1 failed: stderr={}",
            String::from_utf8_lossy(&ps_out.stderr)
        );
        assert_eq!(wait_captured(&out_file), url);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn foreign_file_is_never_overwritten_or_deleted() {
        let dir = std::env::temp_dir().join(format!("aiwb-shim-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let foreign = dir.join("aiwb");
        std::fs::write(&foreign, "#!/bin/sh\necho third-party-tool\n").unwrap();

        assert!(ensure_not_foreign_file(&foreign).is_err());
        assert!(remove_if_owned(&foreign).is_err());
        assert!(foreign.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
