#[cfg(test)]
use std::path::PathBuf;
use std::time::Duration;

use super::mask::mask_matches;
use super::{contains_ignore_case, snippet, SearchHit, SearchOutput};
use crate::features::preview::index::FileIndex;

pub(super) struct SearchCursor {
    pub(super) id: u64,
    query_lower: String,
    mask: String,
    pub(super) hits: Vec<SearchHit>,
    truncated: bool,
    pub(super) done: bool,
    limit: usize,
    cursor: usize,
}

impl SearchCursor {
    pub(super) fn new(id: u64, query: &str, mask: &str, limit: usize) -> Self {
        let query_lower = query.trim().to_lowercase();
        let done = query_lower.is_empty() || limit == 0;
        Self {
            id,
            query_lower,
            mask: mask.to_string(),
            hits: Vec::new(),
            truncated: false,
            done,
            limit,
            cursor: 0,
        }
    }

    pub(super) fn pump(&mut self, budget: Duration, index: &mut FileIndex) {
        if self.done {
            return;
        }
        let start = std::time::Instant::now();
        while !self.done && start.elapsed() < budget {
            if !self.advance_one(index) {
                self.done = true;
                break;
            }
        }
        if self.truncated {
            self.done = true;
        }
    }

    fn advance_one(&mut self, index: &mut FileIndex) -> bool {
        if self.done || self.truncated {
            self.done = true;
            return false;
        }
        if self.cursor < index.file_count() {
            self.consume(index, self.cursor);
            self.cursor += 1;
            if self.truncated {
                self.done = true;
                return false;
            }
            return true;
        }
        if index.complete() {
            self.done = true;
            return false;
        }
        index.pump_steps(1);
        true
    }

    fn consume(&mut self, index: &mut FileIndex, file_index: usize) {
        if self.truncated {
            return;
        }
        let rel = index.file_rel(file_index).to_string();
        if !mask_matches(&self.mask, &rel) {
            return;
        }
        let name_hit = index.name_matches(file_index, &self.query_lower);
        let query = self.query_lower.clone();
        let mut found = Vec::new();
        {
            let (path, name, text) = index.load_text(file_index);
            if name_hit {
                found.push(SearchHit {
                    path: path.to_string(),
                    line: None,
                    text: name.to_string(),
                    kind: "name".into(),
                });
            }
            if let Some(text) = text {
                let path = path.to_string();
                let room = self.limit.saturating_sub(self.hits.len());
                for (line_index, line) in text.split('\n').enumerate() {
                    let line = line.trim_end_matches('\r');
                    if !contains_ignore_case(line, &query) {
                        continue;
                    }
                    if found.len() >= room {
                        found.push(SearchHit {
                            path: path.clone(),
                            line: None,
                            text: String::new(),
                            kind: "overflow".into(),
                        });
                        break;
                    }
                    let line_no = u32::try_from(line_index + 1).unwrap_or(u32::MAX);
                    found.push(SearchHit {
                        path: path.clone(),
                        line: Some(line_no),
                        text: snippet(line, &query),
                        kind: "content".into(),
                    });
                }
            }
        }
        for hit in found {
            if hit.kind == "overflow" {
                self.truncated = true;
                return;
            }
            if !self.push_hit(hit) {
                return;
            }
        }
    }

    fn push_hit(&mut self, hit: SearchHit) -> bool {
        if self.hits.len() >= self.limit {
            self.truncated = true;
            return false;
        }
        self.hits.push(hit);
        true
    }

    pub(super) fn snapshot(&self, cancelled: bool) -> SearchOutput {
        SearchOutput {
            hits: self.hits.clone(),
            truncated: self.truncated,
            done: self.done || cancelled,
            cancelled,
        }
    }
}

#[cfg(test)]
pub(super) struct SearchJob {
    index: FileIndex,
    pub(super) cursor: SearchCursor,
}

#[cfg(test)]
impl SearchJob {
    pub(super) fn new(id: u64, root: PathBuf, query: &str, mask: &str, limit: usize) -> Self {
        Self {
            index: FileIndex::new(root),
            cursor: SearchCursor::new(id, query, mask, limit),
        }
    }

    pub(super) fn pump(&mut self, budget: Duration) {
        self.cursor.pump(budget, &mut self.index);
    }

    #[cfg(test)]
    pub(super) fn pump_steps(&mut self, steps: usize) {
        for _ in 0..steps {
            if self.cursor.done {
                return;
            }
            if !self.cursor.advance_one(&mut self.index) {
                self.cursor.done = true;
                return;
            }
        }
    }

    pub(super) fn snapshot(&self) -> SearchOutput {
        self.cursor.snapshot(false)
    }
}
