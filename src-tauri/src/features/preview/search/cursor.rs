#[cfg(test)]
use std::path::PathBuf;
use std::time::Duration;

use super::content::{scan_file, ReadOutcome};
use super::mask::mask_matches;
use super::{SearchHit, SearchOutput};
use crate::features::preview::index::FileIndex;

pub(super) struct ContentFile {
    pub abs: std::path::PathBuf,
    pub rel: String,
}

pub(super) enum ContentPoll {
    File(ContentFile),
    Rest { done: bool },
}

pub(super) struct SearchCursor {
    pub(super) id: u64,
    query_lower: String,
    mask: String,
    name_hits: Vec<SearchHit>,
    content_hits: Vec<SearchHit>,
    truncated: bool,
    pub(super) done: bool,
    limit: usize,
    name_at: usize,
    content_at: usize,
    #[cfg(test)]
    pub(super) opened: u64,
    #[cfg(test)]
    cancelled: bool,
}

impl SearchCursor {
    pub(super) fn new(id: u64, query: &str, mask: &str, limit: usize) -> Self {
        let query_lower = query.trim().to_lowercase();
        let done = query_lower.is_empty() || limit == 0;
        Self {
            id,
            query_lower,
            mask: mask.to_string(),
            name_hits: Vec::new(),
            content_hits: Vec::new(),
            truncated: false,
            done,
            limit,
            name_at: 0,
            content_at: 0,
            #[cfg(test)]
            opened: 0,
            #[cfg(test)]
            cancelled: false,
        }
    }

    /// 把新扫到的路径收成文件名命中。不打开文件。
    /// 有新文件时返回 true，调用方可以先把这部分结果交出去。
    pub(super) fn flush_names(&mut self, index: &FileIndex) -> bool {
        if self.done || self.name_at >= index.file_count() {
            return false;
        }
        let query = self.query_lower.clone();
        while self.name_at < index.file_count() {
            let file_index = self.name_at;
            self.name_at += 1;
            let rel = index.file_rel(file_index);
            if !mask_matches(&self.mask, rel) || !index.name_matches(file_index, &query) {
                continue;
            }
            if self.total() >= self.limit {
                self.truncated = true;
                self.done = true;
                return true;
            }
            self.name_hits.push(SearchHit {
                path: rel.to_string(),
                line: None,
                text: index.file_name(file_index).to_string(),
                kind: "name".into(),
            });
        }
        true
    }

    pub(super) fn poll_content(&mut self, index: &FileIndex) -> ContentPoll {
        if self.done || self.truncated {
            return ContentPoll::Rest { done: true };
        }
        #[cfg(test)]
        if self.cancelled {
            return ContentPoll::Rest { done: true };
        }
        while self.content_at < index.file_count() {
            let file_index = self.content_at;
            self.content_at += 1;
            let rel = index.file_rel(file_index);
            if !mask_matches(&self.mask, rel) {
                continue;
            }
            return ContentPoll::File(ContentFile {
                abs: index.file_abs(file_index).to_path_buf(),
                rel: rel.to_string(),
            });
        }
        ContentPoll::Rest {
            done: index.complete(),
        }
    }

    pub(super) fn commit_content(&mut self, outcome: ReadOutcome) {
        #[cfg(test)]
        {
            self.opened += 1;
        }
        if self.done {
            return;
        }
        if outcome.overflow {
            self.content_hits.extend(outcome.hits);
            self.truncated = true;
            self.done = true;
            return;
        }
        for hit in outcome.hits {
            if self.total() >= self.limit {
                self.truncated = true;
                self.done = true;
                return;
            }
            self.content_hits.push(hit);
        }
    }

    pub(super) fn room(&self) -> usize {
        self.limit.saturating_sub(self.total())
    }

    pub(super) fn query_lower(&self) -> String {
        self.query_lower.clone()
    }

    fn total(&self) -> usize {
        self.name_hits.len() + self.content_hits.len()
    }

    pub(super) fn snapshot(&self, cancelled: bool) -> SearchOutput {
        let mut hits = self.name_hits.clone();
        hits.extend(self.content_hits.iter().cloned());
        SearchOutput {
            hits,
            truncated: self.truncated,
            done: self.done || cancelled,
            cancelled,
        }
    }

    pub(super) fn read_file(&mut self, file: &ContentFile) -> ReadOutcome {
        scan_file(&file.abs, &file.rel, &self.query_lower, self.room())
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
        let start = std::time::Instant::now();
        while !self.cursor.done && start.elapsed() < budget {
            self.cursor.flush_names(&self.index);
            if !self.index.complete() {
                self.index.pump_budget(Duration::from_millis(10));
                continue;
            }
            if self.cursor.name_at < self.index.file_count() {
                continue;
            }
            match self.cursor.poll_content(&self.index) {
                ContentPoll::Rest { done } => {
                    if done {
                        self.cursor.done = true;
                    }
                    if self.index.complete() {
                        break;
                    }
                }
                ContentPoll::File(file) => {
                    let outcome = self.cursor.read_file(&file);
                    self.cursor.commit_content(outcome);
                }
            }
        }
    }

    pub(super) fn pump_steps(&mut self, steps: usize) {
        for _ in 0..steps {
            if self.cursor.done {
                return;
            }
            if !self.index.complete() {
                self.index.pump_steps(1);
                self.cursor.flush_names(&self.index);
                continue;
            }
            self.cursor.flush_names(&self.index);
            match self.cursor.poll_content(&self.index) {
                ContentPoll::Rest { done } => {
                    if done {
                        self.cursor.done = true;
                    }
                    return;
                }
                ContentPoll::File(file) => {
                    let outcome = self.cursor.read_file(&file);
                    self.cursor.commit_content(outcome);
                }
            }
        }
    }

    pub(super) fn snapshot(&self) -> SearchOutput {
        self.cursor.snapshot(false)
    }
}
