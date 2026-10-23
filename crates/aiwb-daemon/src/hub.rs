//! 主题广播。每次推送带一个全局递增的序号。
//!
//! 写状态并推送、订阅时取快照，这两件事在同一把锁下进行：
//! 订阅记下当时的序号，之后只转发序号更大的推送，客户端不会先收到新值再收到旧值。

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::broadcast;

#[derive(Debug)]
pub struct Envelope {
    pub seq: u64,
    pub topic: String,
    pub data: Value,
}

pub struct Hub {
    seq: Mutex<u64>,
    tx: broadcast::Sender<Arc<Envelope>>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self {
            seq: Mutex::new(0),
            tx,
        }
    }

    pub fn receiver(&self) -> broadcast::Receiver<Arc<Envelope>> {
        self.tx.subscribe()
    }

    /// 在锁内执行写操作；成功后推送它给出的新值。
    pub fn publish_with<R, E>(
        &self,
        topic: &str,
        write: impl FnOnce() -> Result<(R, Value), E>,
    ) -> Result<R, E> {
        let mut seq = self.seq.lock().unwrap_or_else(|p| p.into_inner());
        let (result, data) = write()?;
        *seq += 1;
        let _ = self.tx.send(Arc::new(Envelope {
            seq: *seq,
            topic: topic.to_string(),
            data,
        }));
        Ok(result)
    }

    /// 在锁内取快照，返回当时的序号。`deliver` 也在锁内调用，要求不阻塞。
    pub fn snapshot_with<E>(
        &self,
        read: impl FnOnce() -> Result<Value, E>,
        deliver: impl FnOnce(u64, Value),
    ) -> Result<(), E> {
        let seq = self.seq.lock().unwrap_or_else(|p| p.into_inner());
        let data = read()?;
        deliver(*seq, data);
        Ok(())
    }
}
