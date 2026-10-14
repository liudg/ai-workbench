//! 搜索掩码。逗号分隔，支持花括号展开和 `*` / `?`。

pub(super) fn mask_matches(mask: &str, relative: &str) -> bool {
    let patterns = split_masks(mask);
    if patterns.is_empty() {
        return true;
    }
    let file_name = relative.rsplit(['/', '\\']).next().unwrap_or(relative);
    patterns.iter().any(|pattern| {
        if pattern == "*" {
            return true;
        }
        let target = if pattern.contains('/') || pattern.contains('\\') {
            relative
        } else {
            file_name
        };
        glob_match(pattern, target)
    })
}

fn split_masks(mask: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth: i32 = 0;
    for ch in mask.chars() {
        match ch {
            '{' => {
                depth += 1;
                current.push(ch);
            }
            '}' => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            ',' | ';' if depth == 0 => {
                let piece = current.trim().to_string();
                if !piece.is_empty() {
                    parts.push(piece);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    let piece = current.trim().to_string();
    if !piece.is_empty() {
        parts.push(piece);
    }
    parts
        .into_iter()
        .flat_map(|part| expand_braces(&part))
        .collect()
}

fn expand_braces(pattern: &str) -> Vec<String> {
    let Some(start) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };
    let Some(end_rel) = pattern[start + 1..].find('}') else {
        return vec![pattern.to_string()];
    };
    let end = start + 1 + end_rel;
    let prefix = &pattern[..start];
    let suffix = &pattern[end + 1..];
    let inner = &pattern[start + 1..end];
    inner
        .split(',')
        .map(|part| format!("{prefix}{}{suffix}", part.trim()))
        .filter(|part| !part.is_empty())
        .collect()
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let pat: Vec<char> = pattern.to_lowercase().chars().collect();
    let text: Vec<char> = text.to_lowercase().chars().collect();
    glob_rec(&pat, &text)
}

fn glob_rec(pat: &[char], text: &[char]) -> bool {
    let mut i = 0;
    let mut j = 0;
    while i < pat.len() {
        if pat[i] == '*' {
            let double = i + 1 < pat.len() && pat[i + 1] == '*';
            i += if double { 2 } else { 1 };
            if i == pat.len() {
                return double || !text[j..].contains(&'/');
            }
            let end = text.len();
            for k in j..=end {
                if !double && text[j..k].contains(&'/') {
                    break;
                }
                if glob_rec(&pat[i..], &text[k..]) {
                    return true;
                }
            }
            return false;
        }
        if j >= text.len() {
            return false;
        }
        if pat[i] == '?' {
            if text[j] == '/' {
                return false;
            }
            i += 1;
            j += 1;
            continue;
        }
        if pat[i] != text[j] {
            return false;
        }
        i += 1;
        j += 1;
    }
    j == text.len()
}

#[cfg(test)]
mod tests {
    use super::mask_matches;

    #[test]
    fn mask_matches_extensions_braces_and_leaves_other_files() {
        assert!(mask_matches("*.ts", "src/app.ts"));
        assert!(mask_matches("*.ts", "src/App.TS"));
        assert!(!mask_matches("*.ts", "src/app.tsx"));
        assert!(mask_matches("*.{ts,tsx}", "src/app.tsx"));
        assert!(mask_matches("*.ts, *.md", "notes.md"));
        assert!(!mask_matches("*.ts, *.md", "pic.png"));
        assert!(mask_matches("", "pic.png"));
        assert!(mask_matches("*", "pic.png"));
    }
}
