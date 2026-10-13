//! 从 CLI 输出里读版本，并比较官方发布号。

pub fn extract_version(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index].is_ascii_digit() {
            if let Some((version, _)) = take_semver(&chars, index) {
                return Some(version);
            }
        }
        index += 1;
    }
    None
}

pub fn parse_published_version(stdout: &str) -> Option<String> {
    for line in stdout.lines().rev() {
        let line = line.trim().trim_matches('"');
        let Some(version) = extract_version(line) else {
            continue;
        };
        if version == line || line.strip_prefix('v') == Some(version.as_str()) {
            return Some(version);
        }
    }
    None
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    let latest_parts = version_core(latest);
    let current_parts = version_core(current);
    if latest_parts.is_empty() || current_parts.is_empty() {
        return false;
    }
    let width = latest_parts.len().max(current_parts.len());
    for index in 0..width {
        let next = latest_parts.get(index).copied().unwrap_or(0);
        let prev = current_parts.get(index).copied().unwrap_or(0);
        if next != prev {
            return next > prev;
        }
    }
    false
}

fn version_core(version: &str) -> Vec<u64> {
    let core = version.split(['-', '+']).next().unwrap_or(version);
    core.split('.')
        .filter_map(|part| part.parse().ok())
        .collect()
}

fn take_semver(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut index = start;
    let mut dots = 0;
    let mut saw_digit = false;
    while index < chars.len() {
        let ch = chars[index];
        if ch.is_ascii_digit() {
            saw_digit = true;
            index += 1;
            continue;
        }
        if ch == '.' && saw_digit && dots < 2 {
            dots += 1;
            saw_digit = false;
            index += 1;
            continue;
        }
        break;
    }
    if dots != 2 || !saw_digit {
        return None;
    }
    Some((chars[start..index].iter().collect(), index))
}

pub(super) fn version_from_output(stdout: &str, stderr: &str) -> Option<String> {
    let line = first_line(stdout).or_else(|| first_line(stderr))?;
    Some(version_token(&line))
}

/// `2026.10.01-e373342` 整段都是版本。普通 `2.1.292 (Claude Code)` 仍只取数字。
fn version_token(line: &str) -> String {
    let trimmed = line.trim();
    let Some(version) = extract_version(trimmed) else {
        return trimmed.to_string();
    };
    let Some(start) = trimmed.find(&version) else {
        return version;
    };
    let rest = &trimmed[start..];
    let after = &rest[version.len()..];
    if !after.starts_with('-') {
        return version;
    }
    let end = after
        .find(|ch: char| ch.is_whitespace())
        .unwrap_or(after.len());
    let suffix = &after[..end];
    if suffix.len() > 1
        && suffix
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
    {
        return format!("{version}{suffix}");
    }
    version
}

pub(super) fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}
