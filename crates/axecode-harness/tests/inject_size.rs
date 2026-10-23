//! Harness layer with the sizes of a real Prime harness (12 prompt notes,
//! 35 memories; synthetic text, same lengths).

use axecode_harness::{EntryKind, HarnessPaths, HarnessStore, NewEntry, Scope};

const NOTES: &[usize] = &[
    400, 600, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700,
];
const MEMORIES: usize = 35;

#[test]
fn layer_lists_every_entry_of_a_large_harness() {
    let root = std::env::temp_dir().join(format!("axecode-harness-{}", uuid::Uuid::new_v4()));
    let store = HarnessStore::new(HarnessPaths::with_home(
        root.join("ws"),
        Some(root.join("home")),
    ));
    let new = |title: String, body: String| NewEntry {
        title,
        body,
        ..Default::default()
    };
    for (i, n) in NOTES.iter().enumerate() {
        store
            .create(
                Scope::Global,
                EntryKind::PromptNote,
                new(format!("note {i}"), "n".repeat(*n)),
            )
            .unwrap();
    }
    for i in 0..MEMORIES {
        store
            .create(
                Scope::Global,
                EntryKind::Memory,
                new(format!("memory {i}"), "m".repeat(1200)),
            )
            .unwrap();
    }
    store
        .create(
            Scope::Project,
            EntryKind::Memory,
            new("project fact".into(), "short".into()),
        )
        .unwrap();

    let layer = axecode_harness::refine::harness_layer(&store)
        .unwrap()
        .unwrap();
    std::fs::remove_dir_all(&root).ok();

    assert!(
        layer.chars().count() <= axecode_harness::inject::MAX_LAYER_CHARS,
        "{}",
        layer.len()
    );
    assert_eq!(layer.matches("[note_").count(), NOTES.len());
    assert_eq!(layer.matches("[mem_").count(), MEMORIES + 1);
    assert!(layer.contains("**project fact**: short"));
    assert!(!layer.contains("not shown"));
    // Notes keep their body (up to MAX_ENTRY_CHARS); memories are summaries.
    assert!(layer.contains(&"n".repeat(1200)));
    assert!(!layer.contains(&"m".repeat(200)));
}
