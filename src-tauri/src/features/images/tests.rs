use super::*;

const MINI_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59, 0xE7, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "ai-workbench-chat-images-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn accepts_forward_slash_windows_png() {
    let dir = temp_dir("ok");
    let file = dir.join("header-opened-preview.png");
    std::fs::write(&file, MINI_PNG).unwrap();
    let forward = file.to_string_lossy().replace('\\', "/");
    let canonical = validate_chat_image(&forward).unwrap();
    let shown = display_path(&canonical);
    assert!(shown
        .to_ascii_lowercase()
        .ends_with("header-opened-preview.png"));
    assert!(!shown.starts_with(r"\\?\"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn accepts_file_url() {
    let dir = temp_dir("file-url");
    let file = dir.join("shot.png");
    std::fs::write(&file, MINI_PNG).unwrap();
    let url = format!("file:///{}", file.to_string_lossy().replace('\\', "/"));
    assert!(validate_chat_image(&url).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rejects_non_images_and_traversal() {
    let dir = temp_dir("reject");
    let text = dir.join("notes.txt");
    std::fs::write(&text, MINI_PNG).unwrap();
    assert!(validate_chat_image(&text.to_string_lossy()).is_err());

    let fake = dir.join("fake.png");
    std::fs::write(&fake, b"not a png").unwrap();
    assert!(validate_chat_image(&fake.to_string_lossy()).is_err());

    assert!(validate_chat_image(r"F:\temp\..\Windows\system.png").is_err());
    assert!(validate_chat_image(r"relative\shot.png").is_err());
    assert!(validate_chat_image("https://cdn.example.com/a.png").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stages_pasted_png_bytes() {
    let dir = temp_dir("stage");
    let encoded = super::encode_base64(MINI_PNG);
    let bytes = decode_base64(&format!("data:image/png;base64,{encoded}")).unwrap();
    let (name, path) = stage_image_bytes(&dir, "clip board.png", &bytes).unwrap();
    assert!(name.ends_with(".png"));
    assert_eq!(std::fs::read(path).unwrap(), MINI_PNG);
    assert!(stage_image_bytes(&dir, "note.txt", b"hello").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
