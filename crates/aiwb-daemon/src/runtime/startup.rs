//! 首轮说明已经随任务落库。这里只投递一次；取消后等待启动返回并关闭句柄。
use super::*;

impl Runtimes {
    pub(crate) fn start_initial(
        self: &Arc<Self>,
        session_id: String,
        message: Option<UserTurn>,
        goal: Option<String>,
        paused: bool,
    ) {
        let cancelled = Arc::new(AtomicBool::new(false));
        self.starting
            .lock()
            .unwrap()
            .insert(session_id.clone(), cancelled.clone());
        let runtimes = self.clone();
        tokio::spawn(async move {
            let result = async {
                if cancelled.load(Ordering::SeqCst) {
                    return Ok(());
                }
                let handle = runtimes.ensure_live(&session_id).await?;
                if cancelled.load(Ordering::SeqCst) {
                    return Ok(());
                }
                if handle.read_only() {
                    return Err("此会话只读，无法发送任务。".to_string());
                }
                if let Some(goal) = goal {
                    handle.set_goal(&goal).await.map_err(|e| e.to_string())?;
                    if cancelled.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    if paused {
                        handle
                            .set_goal_status("paused")
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }
                if cancelled.load(Ordering::SeqCst) {
                    return Ok(());
                }
                if let Some(message) = message {
                    let command =
                        message.text.trim_start().starts_with('/') && message.images.is_empty();
                    // 目标可能已自动开了回合，初始说明直接交给这一轮，不作为后续消息再次排队。
                    handle
                        .deliver_now(message)
                        .await
                        .map_err(|e| e.to_string())?;
                    runtimes.finish_initial_send(
                        &session_id,
                        if command {
                            SessionStatus::Idle
                        } else {
                            SessionStatus::Running
                        },
                    )?;
                } else {
                    runtimes.finish_initial_send(&session_id, SessionStatus::Idle)?;
                }
                Ok::<_, String>(())
            }
            .await;
            if cancelled.load(Ordering::SeqCst) {
                runtimes.stop(&session_id).await;
            } else if let Err(message) = result {
                // start_session 自己的失败已记录；目录、选项、投递失败也必须结束启动。
                let _ = runtimes.record_initial_failure(&session_id, message);
            }
            runtimes.starting.lock().unwrap().remove(&session_id);
        });
    }

    fn finish_initial_send(&self, session_id: &str, status: SessionStatus) -> RuntimeResult<()> {
        let starting = self.starting.lock().unwrap();
        if starting
            .get(session_id)
            .is_some_and(|c| c.load(Ordering::SeqCst))
        {
            return Ok(());
        }
        if self
            .store
            .session(session_id)
            .map_err(|e| e.to_string())?
            .is_some_and(|s| s.status == SessionStatus::Starting)
        {
            self.record(session_id, SessionEventBody::StatusChanged { status })?;
        }
        Ok(())
    }

    pub(super) fn record_initial_failure(
        &self,
        session_id: &str,
        message: String,
    ) -> RuntimeResult<()> {
        let starting = self.starting.lock().unwrap();
        if starting
            .get(session_id)
            .is_some_and(|c| c.load(Ordering::SeqCst))
        {
            return Ok(());
        }
        let Some(session) = self.store.session(session_id).map_err(|e| e.to_string())? else {
            return Ok(());
        };
        // 首轮启动时 start_session 自己的失败已经记过。
        if session.status == SessionStatus::Failed && starting.contains_key(session_id) {
            return Ok(());
        }
        // 打开会话时目录、权限菜单、目标等各自要句柄，同一个失败会报好几次；重启后再打开也一样。
        if !self.repeats_last_error(session_id, &message)? {
            self.record(session_id, SessionEventBody::Error { message })?;
        }
        if session.status != SessionStatus::Failed {
            self.record(
                session_id,
                SessionEventBody::StatusChanged {
                    status: SessionStatus::Failed,
                },
            )?;
        }
        Ok(())
    }

    /// 时间线最后一条不是状态的事件就是这条报错。
    fn repeats_last_error(&self, session_id: &str, message: &str) -> RuntimeResult<bool> {
        let mut logs = self.logs.lock().unwrap();
        let log = self.log_mut(&mut logs, session_id)?;
        Ok(log
            .events
            .iter()
            .rev()
            .find(|event| !matches!(event.body, SessionEventBody::StatusChanged { .. }))
            .is_some_and(|event| matches!(&event.body, SessionEventBody::Error { message: last } if last == message)))
    }

    pub(super) fn initial_cancelled(&self, session_id: &str) -> bool {
        self.starting
            .lock()
            .unwrap()
            .get(session_id)
            .is_some_and(|c| c.load(Ordering::SeqCst))
    }

    pub(super) fn cancel_initial(&self, session_id: &str) -> bool {
        let starting = self.starting.lock().unwrap();
        if let Some(cancelled) = starting.get(session_id) {
            cancelled.store(true, Ordering::SeqCst);
            return true;
        }
        false
    }
}
