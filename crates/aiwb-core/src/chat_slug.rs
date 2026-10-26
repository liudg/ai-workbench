//! 独立聊天的目录名，取自第一条消息。照 v1 `src-tauri/src/features/chats/slug.rs`。

/// 从首条提示词取出目录名。只保留 [a-z0-9] 词，最多 6 个，总长不超过 80。
pub fn chat_slug(prompt: &str) -> String {
    const MAX_WORDS: usize = 6;
    const MAX_LEN: usize = 80;
    let mut words = Vec::new();
    let mut current = String::new();
    for ch in prompt.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch.to_ascii_lowercase());
            continue;
        }
        if current.is_empty() {
            continue;
        }
        words.push(std::mem::take(&mut current));
        if words.len() == MAX_WORDS {
            break;
        }
    }
    if !current.is_empty() && words.len() < MAX_WORDS {
        words.push(current);
    }
    if words.is_empty() {
        return "new-chat".to_string();
    }
    let mut slug = words.join("-");
    if slug.len() > MAX_LEN {
        slug.truncate(MAX_LEN);
        slug = slug.trim_end_matches('-').to_string();
    }
    if slug.is_empty() {
        "new-chat".to_string()
    } else {
        slug
    }
}

pub fn candidate_name(slug: &str, index: usize) -> String {
    if index == 0 {
        slug.to_string()
    } else {
        format!("{slug}-{}", index + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_ascii_words_in_order() {
        assert_eq!(chat_slug("Fix the Login, please!"), "fix-the-login-please");
    }

    #[test]
    fn caps_at_six_words_and_eighty_chars() {
        assert_eq!(chat_slug("a b c d e f g h"), "a-b-c-d-e-f");
        let long = "x".repeat(100);
        assert_eq!(chat_slug(&long).len(), 80);
    }

    #[test]
    fn empty_and_non_ascii_become_new_chat() {
        assert_eq!(chat_slug(""), "new-chat");
        assert_eq!(chat_slug("   "), "new-chat");
        assert_eq!(chat_slug("整理发布说明"), "new-chat");
    }

    #[test]
    fn underscore_splits_words() {
        assert_eq!(chat_slug("foo_bar Baz"), "foo-bar-baz");
    }

    #[test]
    fn duplicate_suffix_starts_at_two() {
        assert_eq!(candidate_name("new-chat", 0), "new-chat");
        assert_eq!(candidate_name("new-chat", 1), "new-chat-2");
        assert_eq!(candidate_name("new-chat", 2), "new-chat-3");
    }
}
