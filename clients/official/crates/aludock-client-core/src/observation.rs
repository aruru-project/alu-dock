//! Protocol continuation and automatic recovery; content commits have one owner.
use crate::{
    ClientError, DockClient, ReadReplay, Result, SessionBinding, SessionContent, SessionUpdate,
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::task::JoinHandle;
enum Admission {
    Continue,
    ReadRequired,
    Replacement,
    Terminal,
    Superseded,
}
const RETRY_DELAY: Duration = Duration::from_millis(1500);
#[derive(Clone, Default)]
pub struct ConversationObservation {
    pub content: SessionContent,
    active: Arc<Mutex<Option<(String, JoinHandle<()>)>>>,
}
impl ConversationObservation {
    pub fn new(content: SessionContent) -> Self {
        Self {
            content,
            active: Default::default(),
        }
    }
    pub fn bind(
        &self,
        key: String,
        client: DockClient,
        instance_id: String,
        host_epoch: String,
        refresh: bool,
    ) -> Result<SessionBinding> {
        let mut active = self.active.lock().unwrap();
        let body_client = client.clone();
        let continuing = active
            .as_ref()
            .is_some_and(|(target, task)| target == &key && !task.is_finished());
        if !continuing || refresh {
            if let Some((previous, task)) = active.take() {
                if previous != key {
                    self.content.pause_content_reads(&previous);
                }
                self.content.claim(&previous); // revoke before abort (also fences a running publish)
                task.abort();
            }
            let owner = self.content.claim(&key);
            let service = self.clone();
            let task_key = key.clone();
            let task = tokio::spawn(async move {
                service
                    .run(task_key, owner, client, instance_id, host_epoch, refresh)
                    .await;
            });
            *active = Some((key.clone(), task));
        }
        let binding = self.content.bind(&key)?;
        if let Some(token) = self.content.content_token(&key) {
            self.content.wake_body_reader(&key, &token, body_client);
        }
        Ok(binding)
    }
    pub fn pause(&self, key: &str) {
        let mut active = self.active.lock().unwrap();
        if active.as_ref().is_some_and(|(target, _)| target == key) {
            self.content.pause_content_reads(key);
            let owner = self.content.claim(key);
            if let Some((_, task)) = active.take() {
                task.abort();
            }
            let _ = self.content.commit(
                key,
                owner,
                SessionUpdate::Status {
                    state: "paused".into(),
                    message: None,
                },
            );
        }
    }
    pub fn accept_session_result(
        &self,
        key: &str,
        client: DockClient,
        result: &impl crate::sessions::SessionChange,
    ) {
        let Some((target, branch_changed)) = result.replacement() else {
            return;
        };
        if self
            .replace(key, client, target.clone(), branch_changed)
            .is_err()
        {
            self.content
                .report_display_error(key, "操作已完成，但无法更新显示。请刷新当前工作。");
        }
    }
    pub fn replace(
        &self,
        key: &str,
        client: DockClient,
        target: crate::InstanceSnapshot,
        branch_changed: bool,
    ) -> Result<()> {
        let instance = target.id.clone();
        let host_epoch = target.owner_host_epoch.clone().unwrap_or_default();
        let mut active = self.active.lock().unwrap();
        if !self.content.contains(key) {
            self.content.claim(key);
        }
        if self.content.replace(key, target, branch_changed)?
            && active.as_ref().is_some_and(|(current, _)| current == key)
        {
            if let Some((_, task)) = active.take() {
                task.abort();
            }
            let owner = self.content.claim(key);
            let service = self.clone();
            let task_key = key.to_owned();
            let task = tokio::spawn(async move {
                service
                    .run(task_key, owner, client, instance, host_epoch, true)
                    .await;
            });
            *active = Some((key.to_owned(), task));
        }
        Ok(())
    }
    fn accept(&self, key: &str, owner: u64, update: SessionUpdate) -> Result<Admission> {
        let is_read = matches!(&update, SessionUpdate::Read(_));
        let replacement = matches!(&update, SessionUpdate::Event(event) if matches!(event.event_type.as_str(), "session.replaced" | "session.navigated"));
        let accepted = self.content.commit(key, owner, update)?;
        if !self.content.owns(key, owner) {
            return Ok(Admission::Superseded);
        }
        if self.content.terminal(key, owner) {
            self.content.pause_content_reads(key);
            self.content.commit(
                key,
                owner,
                SessionUpdate::Status {
                    state: "stopped".into(),
                    message: None,
                },
            )?;
            return Ok(Admission::Terminal);
        }
        // A stale response can lose to another read owned by this same task.
        // It must not end Follow, nor allow a replacement with no read to skip
        // its required bootstrap. The accepted cursor/read remain authoritative.
        if is_read && self.content.needs_read(key, owner) {
            return Ok(Admission::ReadRequired);
        }
        Ok(if accepted && replacement {
            Admission::Replacement
        } else {
            Admission::Continue
        })
    }
    async fn accept_read(
        &self,
        key: &str,
        owner: u64,
        read: crate::InstanceReadResult,
    ) -> Result<Admission> {
        let (service, key) = (self.clone(), key.to_owned());
        tokio::task::spawn_blocking(move || service.accept(&key, owner, SessionUpdate::Read(read)))
            .await
            .map_err(|error| {
                ClientError::Protocol(format!("local content commit task failed: {error}"))
            })?
    }
    async fn run(
        &self,
        key: String,
        owner: u64,
        client: DockClient,
        instance: String,
        host_epoch: String,
        mut read_required: bool,
    ) {
        let checkpoint_pending = Arc::new(AtomicBool::new(false));
        loop {
            if !self.content.owns(&key, owner)
                || (!read_required && self.content.terminal(&key, owner))
            {
                return;
            }
            let _ = self.content.commit(
                &key,
                owner,
                SessionUpdate::Status {
                    state: "connecting".into(),
                    message: None,
                },
            );
            if read_required || self.content.needs_read(&key, owner) {
                match client
                    .read_instance(&instance, None, ReadReplay::ConversationBootstrap)
                    .await
                {
                    Ok(read) if read.page.latest.host_epoch != host_epoch => {
                        let _ = self.content.commit(
                            &key,
                            owner,
                            SessionUpdate::Status {
                                state: "host_changed".into(),
                                message: Some("Host 已重新启动，请刷新工作列表。".into()),
                            },
                        );
                        return;
                    }
                    Ok(read) => match self.accept_read(&key, owner, read).await {
                        Ok(Admission::Continue) => {
                            read_required = false;
                            let (content, key, client) =
                                (self.content.clone(), key.clone(), client.clone());
                            tokio::spawn(async move {
                                let _ = content.reconcile_checkpoint(&key, &client).await;
                                if let Some(token) = content.owned_content_token(&key, owner) {
                                    content.wake_body_reader(&key, &token, client);
                                }
                            });
                        }
                        Ok(Admission::ReadRequired) => {
                            read_required = true;
                            continue;
                        }
                        Ok(_) => return,
                        Err(error) => {
                            if !self.failed(&key, owner, &error).await {
                                return;
                            }
                            continue;
                        }
                    },
                    Err(error) => {
                        if !self.failed(&key, owner, &error).await {
                            return;
                        }
                        continue;
                    }
                }
            }
            let Some(cursor) = self.content.cursor(&key, owner) else {
                return;
            };
            match client.follow_instance(&instance, &cursor).await {
                Ok((initial, mut stream)) => {
                    if initial.truncated || initial.epoch_changed || initial.generation_changed {
                        read_required = true;
                        continue;
                    }
                    for event in initial.events {
                        match self.accept(&key, owner, SessionUpdate::Event(event)) {
                            Ok(Admission::Continue) => {}
                            Ok(Admission::Replacement) => {
                                read_required = true;
                                break;
                            }
                            Ok(_) => return,
                            Err(error) => {
                                self.failed(&key, owner, &error).await;
                                return;
                            }
                        }
                    }
                    if read_required {
                        continue;
                    }
                    let _ = self.content.commit(
                        &key,
                        owner,
                        SessionUpdate::Status {
                            state: "connected".into(),
                            message: None,
                        },
                    );
                    loop {
                        match stream.next_event().await {
                            Ok(event) => {
                                let settled = matches!(
                                    event.event_type.as_str(),
                                    "run.settled" | "compaction.completed"
                                );
                                match self.accept(&key, owner, SessionUpdate::Event(event)) {
                                    Ok(Admission::Continue) => {}
                                    Ok(Admission::Replacement) => {
                                        read_required = true;
                                        break;
                                    }
                                    Ok(_) => return,
                                    Err(error) => {
                                        self.failed(&key, owner, &error).await;
                                        return;
                                    }
                                }
                                // A settled run is a useful authority checkpoint;
                                // failure never interrupts an otherwise valid Follow.
                                if settled && !checkpoint_pending.swap(true, Ordering::AcqRel) {
                                    let (service, key, client, instance, pending, expected_epoch) = (
                                        self.clone(),
                                        key.clone(),
                                        client.clone(),
                                        instance.clone(),
                                        checkpoint_pending.clone(),
                                        host_epoch.clone(),
                                    );
                                    tokio::spawn(async move {
                                        match client
                                            .read_instance(
                                                &instance,
                                                None,
                                                ReadReplay::ConversationBootstrap,
                                            )
                                            .await
                                        {
                                            Ok(read)
                                                if read.page.latest.host_epoch
                                                    == expected_epoch =>
                                            {
                                                let _ =
                                                    service.accept_read(&key, owner, read).await;
                                                let _ = service
                                                    .content
                                                    .reconcile_checkpoint(&key, &client)
                                                    .await;
                                            }
                                            Err(error)
                                                if failure_state(&error) == "unavailable" =>
                                            {
                                                service.failed(&key, owner, &error).await;
                                            }
                                            _ => {} // Optional checkpoint failure never interrupts a valid Follow.
                                        }
                                        pending.store(false, Ordering::Release);
                                    });
                                }
                            }
                            Err(error) => {
                                if !self.failed(&key, owner, &error).await {
                                    return;
                                }
                                break;
                            }
                        }
                    }
                }
                Err(error) => {
                    if !self.failed(&key, owner, &error).await {
                        return;
                    }
                }
            }
        }
    }
    async fn failed(&self, key: &str, owner: u64, error: &ClientError) -> bool {
        if self.content.terminal(key, owner) {
            return false;
        }
        let state = failure_state(error);
        let message = match state {
            "unavailable" => "这项工作当前不可用，请刷新工作列表。",
            "identity_error" => "无法确认 Host 身份或连接授权，请检查 Host 设置后重试。",
            _ => "连接暂时中断，正在尝试恢复。你可以继续编辑。",
        };
        let accepted = self
            .content
            .commit(
                key,
                owner,
                SessionUpdate::Status {
                    state: state.into(),
                    message: Some(message.into()),
                },
            )
            .unwrap_or(false);
        if !accepted || state != "disconnected" {
            return false;
        }
        tokio::time::sleep(RETRY_DELAY).await;
        true
    }
}

fn failure_state(error: &ClientError) -> &'static str {
    match error {
        ClientError::HostCertificateMismatch | ClientError::MissingHostCertificate => {
            "identity_error"
        }
        ClientError::Host { code, .. }
            if matches!(
                code.as_str(),
                "unauthorized" | "device_revoked" | "authentication_failed"
            ) =>
        {
            "identity_error"
        }
        ClientError::Host { code, .. }
            if matches!(code.as_str(), "not_found" | "instance_not_active") =>
        {
            "unavailable"
        }
        _ => "disconnected",
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::tls::{read_json_line, write_json_line};
    use crate::{
        ConnectionRouter, IdentityStore, LocalDockEndpoint, OperationAssociation,
        OperationAssociations, OperationState,
    };
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn cursor(sequence: u64, generation: u64) -> Value {
        json!({"hostEpoch":"epoch","instanceId":"work","runtimeGeneration":generation,"sequence":sequence})
    }
    fn instance(generation: u64) -> Value {
        json!({
            "id":"work", "creationOperationId":"create", "displayName":"Work", "cwd":"/isolated", "lifecycle":"active", "execution":"idle",
            "compacting":false, "lastRun":"never", "reopenable":false, "runtimeGeneration":generation,"ownerHostEpoch":"epoch",
            "pending":{"steering":0,"followUp":0,"total":0}, "executor":{"kind":"pi","piSessionId":format!("session-{generation}")},
            "toolsExpanded":false,"createdAt":"now","updatedAt":"now","executionChangedAt":"now","eventCursor":cursor(10,generation)
        })
    }
    fn read() -> Value {
        json!({"instance":instance(1),"page":{"events":[],"earliest":cursor(10,1),"latest":cursor(10,1),
        "truncated":false,"epochChanged":false,"generationChanged":false},"recentHistory":[],"historyRevision":1,"historyTruncated":false,"pendingMessages":[]})
    }

    async fn next_content_record(binding: &mut SessionBinding) -> crate::HistoryRecord {
        let mut text = String::new();
        loop {
            for commit in binding.next_batch().await.unwrap() {
                if let SessionUpdate::Content {
                    update:
                        crate::ContentUpdate::RecordChunk {
                            text: chunk,
                            first,
                            complete,
                            ..
                        },
                    ..
                } = commit.update
                {
                    if first {
                        text.clear();
                    }
                    text.push_str(&chunk);
                    if complete {
                        return serde_json::from_str(&text).unwrap();
                    }
                }
            }
        }
    }

    // Windows cold Work opens previously wrote and reread every body before
    // display. Exercise the real Host read -> content admission -> binding path.
    #[tokio::test]
    async fn cold_host_history_and_native_rebind_display_complete_utf8_without_body_files() {
        let directory = std::env::temp_dir().join(format!(
            "cold-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ));
        std::fs::create_dir(&directory).unwrap();
        let endpoint = directory.join("s");
        let listener = tokio::net::UnixListener::bind(&endpoint).unwrap();
        let expected = "中文🦉".repeat(18000);
        let mut response = read();
        response["recentHistory"] = json!((0..3).map(|i| json!({"recordId":format!("r{i}"),"entryId":format!("r{i}"),"kind":"message","source":"user","visibility":"conversation","content":[{"type":"text","text":expected}]})).collect::<Vec<_>>());
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio::io::BufReader::new(socket);
            let hello: Value = read_json_line(&mut socket, 1024 * 1024).await.unwrap();
            write_json_line(&mut socket, &json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,"host":{"hostEpoch":"epoch"},"capabilities":hello["requiredCapabilities"],"limits":{"maxLineBytes":1048576}})).await.unwrap();
            let request: Value = read_json_line(&mut socket, 1024 * 1024).await.unwrap();
            assert_eq!(request["type"], "instance.read");
            write_json_line(&mut socket, &json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,"result":response})).await.unwrap();
        });
        let client = DockClient::new(
            ConnectionRouter::local(
                &IdentityStore::new(directory.join("identity")),
                LocalDockEndpoint::configured(endpoint.to_str().unwrap()).unwrap(),
                "cold-open".into(),
            )
            .unwrap(),
        );
        let cache = directory.join("cache");
        let content = SessionContent::in_directory(cache.clone()).unwrap();
        let run = std::fs::read_dir(&cache)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.is_dir())
            .unwrap();
        let files = || {
            std::fs::read_dir(&run)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<std::collections::BTreeSet<_>>()
        };
        let before = files();
        let owner = content.claim("work");
        let mut binding = content.bind("work").unwrap();
        let read = client
            .read_instance("work", None, ReadReplay::ConversationBootstrap)
            .await
            .unwrap();
        content
            .commit("work", owner, SessionUpdate::Read(read))
            .unwrap();
        peer.await.unwrap();
        for _ in 0..2 {
            let mut bodies = Vec::new();
            let mut encoded = String::new();
            let mut batches = 0;
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let batch = binding.next_batch().await.unwrap();
                    batches += 1;
                    let mut ended = false;
                    for commit in batch {
                        match commit.update {
                            SessionUpdate::Content {
                                update:
                                    crate::ContentUpdate::RecordChunk {
                                        text,
                                        first,
                                        complete,
                                        ..
                                    },
                                ..
                            } => {
                                assert!(text.len() <= 32768);
                                if first {
                                    encoded.clear();
                                }
                                encoded.push_str(&text);
                                if complete {
                                    bodies.push(
                                        serde_json::from_str::<crate::HistoryRecord>(&encoded)
                                            .unwrap(),
                                    );
                                }
                            }
                            SessionUpdate::Content {
                                update: crate::ContentUpdate::CheckpointEnd,
                                ..
                            } => ended = true,
                            _ => {}
                        }
                    }
                    if ended {
                        break;
                    }
                }
            })
            .await
            .unwrap();
            assert!(
                batches > 1,
                "long history arrives in a first batch and continuations"
            );
            assert_eq!(
                bodies
                    .iter()
                    .map(|record| record.entry_id.as_str())
                    .collect::<Vec<_>>(),
                ["r0", "r1", "r2"]
            );
            assert!(bodies.iter().all(|record| matches!(&record.content[0], crate::ContentBlock::Text { text } if text == &expected)));
            assert_eq!(
                files(),
                before,
                "body and journal preparation must not add files before display or rebind"
            );
            binding = content.bind("work").unwrap();
        }
        drop(binding);
        drop(content);
        std::fs::remove_dir_all(directory).unwrap();
    }

    // #319: cached content is not an admission authority, but the negotiated
    // Host incarnation must match the caller before any Session request is sent.
    #[tokio::test]
    async fn session_actions_allow_newer_or_uncached_targets_and_fence_restarted_hosts() {
        use tokio::io::AsyncBufReadExt;
        let directory = std::env::temp_dir().join(format!(
            "sf-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ));
        std::fs::create_dir(&directory).unwrap();
        let socket = directory.join("s");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let peer = tokio::spawn(async move {
            for host in ["restarted", "epoch", "epoch", "different-epoch"] {
                let mut stream = tokio::io::BufReader::new(listener.accept().await.unwrap().0);
                let hello: Value = read_json_line(&mut stream, 65536).await.unwrap();
                write_json_line(&mut stream, &json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,
                    "host":{"hostEpoch":host},"capabilities":["core.v2","extension_ui.tools-expanded.v1","git.branch-footer.v1","instance.keys.v1","instance.display-name.v1","session.commands.v1"],"limits":{"maxLineBytes":65536}})).await.unwrap();
                let mut line = String::new();
                let bytes = stream.read_line(&mut line).await.unwrap();
                if host == "restarted" {
                    assert_eq!(
                        bytes, 0,
                        "a stale page must send no Session mutation to the restarted Host"
                    );
                    continue;
                }
                let request: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["type"], "session.new");
                let mut target = instance(2);
                target["ownerHostEpoch"] = json!(host);
                target["eventCursor"]["hostEpoch"] = json!(host);
                write_json_line(&mut stream, &json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":host,"ok":true,"result":{"cancelled":false,"instance":target}})).await.unwrap();
            }
        });
        let client = DockClient::new(
            ConnectionRouter::local(
                &IdentityStore::new(directory.join("identity")),
                LocalDockEndpoint::configured(socket.to_str().unwrap()).unwrap(),
                "session-fence".into(),
            )
            .unwrap(),
        );
        let content = SessionContent::default();
        let owner = content.claim("work");
        content
            .commit(
                "work",
                owner,
                SessionUpdate::Read(serde_json::from_value(read()).unwrap()),
            )
            .unwrap();
        assert!(content.check_target("work", "epoch", 1).unwrap().is_some());
        assert!(matches!(
            client
                .with_host_epoch("epoch")
                .new_session("work", None, Some("old-host"))
                .await,
            Err(ClientError::Protocol(_))
        ));
        assert!(content.check_target("work", "epoch", 2).unwrap().is_none());
        assert!(
            !client
                .with_host_epoch("epoch")
                .new_session("work", None, Some("newer-target"))
                .await
                .unwrap()
                .cancelled
        );
        assert!(
            content
                .check_target("unobserved", "epoch", 1)
                .unwrap()
                .is_none()
        );
        assert!(
            !client
                .with_host_epoch("epoch")
                .new_session("work", None, Some("unobserved"))
                .await
                .unwrap()
                .cancelled
        );
        content
            .replace("work", serde_json::from_value(instance(2)).unwrap(), false)
            .unwrap();
        assert!(content.check_target("work", "epoch", 1).is_err());
        assert!(
            content
                .check_target("work", "different-epoch", 1)
                .unwrap()
                .is_none()
        );
        assert!(
            !client
                .with_host_epoch("different-epoch")
                .new_session("work", None, Some("other-host"))
                .await
                .unwrap()
                .cancelled
        );
        peer.await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    // #301/#302: a rebuilt WebView reconnects to native facts, not to a new
    // mutation. A long valid Follow is not stopped merely to bound hot memory.
    #[tokio::test]
    async fn observation_and_operation_survive_view_rebind_without_replay() {
        // Keep the Unix socket below SUN_LEN with an isolated, longer TMPDIR.
        let directory = std::env::temp_dir().join(format!(
            "ao-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ));
        std::fs::create_dir(&directory).unwrap();
        let endpoint = directory.join("s");
        let listener = tokio::net::UnixListener::bind(&endpoint).unwrap();
        let reads = Arc::new(AtomicUsize::new(0));
        let sends = Arc::new(AtomicUsize::new(0));
        let follows = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(tokio::sync::Notify::new());
        let (r, s, f, gate) = (
            reads.clone(),
            sends.clone(),
            follows.clone(),
            release.clone(),
        );
        let peer = tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = tokio::io::BufReader::new(socket);
                let (r, s, f, gate) = (r.clone(), s.clone(), f.clone(), gate.clone());
                tokio::spawn(async move {
                    let hello: Value = read_json_line(&mut socket, 1024 * 1024).await.unwrap();
                    write_json_line(&mut socket, &json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,
                        "host":{"hostEpoch":"epoch"},"capabilities":hello["requiredCapabilities"],"limits":{"maxLineBytes":1048576}})).await.unwrap();
                    let request: Value = read_json_line(&mut socket, 1024 * 1024).await.unwrap();
                    let result = match request["type"].as_str().unwrap() {
                        "instance.read" => {
                            r.fetch_add(1, Ordering::SeqCst);
                            read()
                        }
                        "session.new" => {
                            s.fetch_add(1, Ordering::SeqCst);
                            if request["params"]["operationId"] == "new-lost" {
                                return;
                            }
                            gate.notified().await;
                            json!({"cancelled":false,"instance":instance(2)})
                        }
                        "instance.follow" => {
                            let index = f.fetch_add(1, Ordering::SeqCst);
                            let since = request["params"]["since"].clone();
                            write_json_line(&mut socket, &json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,
                                "result":{"page":{"events":[],"earliest":since,"latest":since,"truncated":false,"epochChanged":false,"generationChanged":false}}})).await.unwrap();
                            let start = if index == 0 { 11 } else { 312 };
                            let end = if index == 0 { 311 } else { 312 };
                            if index > 0 {
                                assert_eq!(request["params"]["since"]["sequence"], 311);
                            }
                            for sequence in start..=end {
                                write_json_line(&mut socket, &json!({"kind":"event","version":2,"requestId":request["requestId"],"hostEpoch":"epoch",
                                    "event":{"scope":"instance","instanceId":"work","runtimeGeneration":1,"sequence":sequence,"occurredAt":"now",
                                        "type":"extension.status_changed","data":{"key":"phase","text":format!("{sequence}")}}})).await.unwrap();
                            }
                            if index > 0 {
                                std::future::pending::<()>().await;
                            }
                            return;
                        }
                        other => panic!("unexpected operation {other}"),
                    };
                    write_json_line(&mut socket, &json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,"result":result})).await.unwrap();
                });
            }
        });
        let client = DockClient::new(
            ConnectionRouter::local(
                &IdentityStore::new(directory.join("identity")),
                LocalDockEndpoint::configured(endpoint.to_str().unwrap()).unwrap(),
                "isolated".into(),
            )
            .unwrap(),
        );
        let service = ConversationObservation::default();
        let mut updates = service
            .bind(
                "authority:work:epoch".into(),
                client.clone(),
                "work".into(),
                "epoch".into(),
                false,
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if updates.next_batch().await.unwrap().iter().any(
                    |commit| matches!(&commit.update,SessionUpdate::Event(e) | SessionUpdate::ReplayEvent { event: e, .. } if e.sequence == 312),
                ) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let mut rebound = service
            .bind(
                "authority:work:epoch".into(),
                client.clone(),
                "work".into(),
                "epoch".into(),
                false,
            )
            .unwrap();
        let mut count = 0;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let batch = rebound.next_batch().await.unwrap();
                count += batch
                    .iter()
                    .filter(|commit| matches!(&commit.update, SessionUpdate::Event(_) | SessionUpdate::ReplayEvent { .. }))
                    .count();
                if batch.iter().any(
                    |commit| matches!(&commit.update,SessionUpdate::Event(e) | SessionUpdate::ReplayEvent { event: e, .. } if e.sequence == 312),
                ) {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(count, 302);
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "long Follow and disconnection resume do not trigger threshold reads"
        );
        assert_eq!(follows.load(Ordering::SeqCst), 2);
        let operations = OperationAssociations::default();
        let metadata = OperationAssociation {
            operation_id: "new-once".into(),
            kind: "new_session".into(),
            connection_id: "host".into(),
            instance_id: "work".into(),
            host_epoch: "epoch".into(),
            runtime_generation: 1,
            session_id: "session-1".into(),
            editor: json!({"textRevision":"original"}),
            state: OperationState::Pending,
            result: None,
            error: None,
        };
        let owner = operations.clone();
        let transport = client.clone();
        let waiter = tokio::spawn(async move {
            owner
                .execute(metadata, async move {
                    transport.new_session("work", None, Some("new-once")).await
                })
                .await
        });
        while sends.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        waiter.abort(); // WebView/IPC waiter disappeared, not the native operation.
        assert_eq!(operations.pending()[0].state, OperationState::Pending);
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), async {
            while operations.pending()[0].state == OperationState::Pending {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let result = operations.pending().remove(0);
        assert_eq!(result.state, OperationState::Succeeded);
        assert_eq!(result.editor["textRevision"], "original");
        assert_eq!(sends.load(Ordering::SeqCst), 1);
        let images = service.content.restored_images();
        let image_scope = crate::restored_image_scope("local", 1, "work", "epoch", 1);
        images.append(
            image_scope.clone(),
            vec![crate::ImagePath {
                path: "/old/image.png".into(),
                mime_type: "image/png".into(),
            }],
        );
        service.accept_session_result(
            "authority:work:epoch",
            client.clone(),
            &serde_json::from_value::<crate::SessionReplacementResult>(result.result.unwrap())
                .unwrap(),
        );
        assert!(
            images.capture(&image_scope).is_none(),
            "accepted replacement clears Queue images before any binding/ACK"
        );
        let replaced = service
            .content
            .bind("authority:work:epoch")
            .unwrap()
            .snapshot;
        assert!(replaced.read.is_none());
        assert_eq!(replaced.target.unwrap().runtime_generation, 2);
        let owner = service.content.claim("authority:work:epoch");
        let mut accepted_new = read();
        accepted_new["instance"] = instance(2);
        accepted_new["page"]["earliest"] = cursor(10, 2);
        accepted_new["page"]["latest"] = cursor(10, 2);
        accepted_new["recentHistory"] = json!([{"recordId":"new-entry","entryId":"new-entry","kind":"message","source":"user","visibility":"conversation","content":[{"type":"text","text":"new Session retained"}]}]);
        service
            .content
            .commit(
                "authority:work:epoch",
                owner,
                SessionUpdate::Read(serde_json::from_value(accepted_new).unwrap()),
            )
            .unwrap();
        let before_late = service
            .content
            .bind("authority:work:epoch")
            .unwrap()
            .snapshot;
        let mut late = instance(1);
        late["eventCursor"] = cursor(500, 1);
        service
            .replace(
                "authority:work:epoch",
                client.clone(),
                serde_json::from_value(late).unwrap(),
                true,
            )
            .unwrap();
        let after_late = service
            .content
            .bind("authority:work:epoch")
            .unwrap()
            .snapshot;
        assert_eq!(
            after_late.revision, before_late.revision,
            "older navigate cannot revoke or publish after a newer Session"
        );
        assert!(
            service.content.owns("authority:work:epoch", owner),
            "stale receipt cannot revoke the accepted reader"
        );
        assert_eq!(
            after_late.target.unwrap().executor.pi_session_id,
            "session-2"
        );
        assert_eq!(
            next_content_record(&mut service.content.bind("authority:work:epoch").unwrap())
                .await
                .entry_id,
            "new-entry"
        );
        let owner = service.content.claim("branch");
        service
            .content
            .commit(
                "branch",
                owner,
                SessionUpdate::Read(serde_json::from_value(read()).unwrap()),
            )
            .unwrap();
        images.append(
            image_scope.clone(),
            vec![crate::ImagePath {
                path: "/old/branch.png".into(),
                mime_type: "image/png".into(),
            }],
        );
        let mut newer_branch = instance(1);
        newer_branch["eventCursor"] = cursor(30, 1);
        service
            .replace(
                "branch",
                client.clone(),
                serde_json::from_value(newer_branch.clone()).unwrap(),
                true,
            )
            .unwrap();
        assert!(
            images.capture(&image_scope).is_none(),
            "same-generation navigation clears images without an observed view"
        );
        images.append(
            image_scope.clone(),
            vec![crate::ImagePath {
                path: "/new/branch.png".into(),
                mime_type: "image/png".into(),
            }],
        );
        let branch_revision = service.content.bind("branch").unwrap().snapshot.revision;
        newer_branch["eventCursor"] = cursor(20, 1);
        service
            .replace(
                "branch",
                client.clone(),
                serde_json::from_value(newer_branch).unwrap(),
                true,
            )
            .unwrap();
        assert_eq!(
            service.content.bind("branch").unwrap().snapshot.revision,
            branch_revision,
            "same-domain navigation receipts follow authoritative positions"
        );
        assert_eq!(
            images.capture(&image_scope).unwrap().images[0].path,
            "/new/branch.png",
            "late older receipt preserves new branch images"
        );
        let unobserved = ConversationObservation::default();
        let unobserved_images = unobserved.content.restored_images();
        unobserved_images.append(
            image_scope.clone(),
            vec![crate::ImagePath {
                path: "/unobserved/old.png".into(),
                mime_type: "image/png".into(),
            }],
        );
        unobserved.accept_session_result(
            "unobserved",
            client.clone(),
            &crate::SessionNavigateResult {
                cancelled: false,
                aborted: None,
                editor_text: None,
                instance: serde_json::from_value(instance(1)).unwrap(),
            },
        );
        assert!(
            unobserved_images.capture(&image_scope).is_none(),
            "navigation clears old images even when no observation was ever opened"
        );
        operations.consume("new-once");
        assert!(operations.pending().is_empty());
        let model = SessionContent::default();
        let old_owner = model.claim("work");
        model
            .commit(
                "work",
                old_owner,
                SessionUpdate::Read(serde_json::from_value(read()).unwrap()),
            )
            .unwrap();
        assert!(
            model
                .replace(
                    "work",
                    serde_json::from_value({
                        let mut value = instance(1);
                        value["eventCursor"] = cursor(11, 1);
                        value
                    })
                    .unwrap(),
                    true
                )
                .unwrap()
        );
        let changed = model.bind("work").unwrap().snapshot;
        assert!(
            !model
                .commit(
                    "work",
                    old_owner,
                    SessionUpdate::Read(serde_json::from_value(read()).unwrap())
                )
                .unwrap(),
            "late same-runtime branch read cannot undo navigation"
        );
        assert_eq!(
            model.bind("work").unwrap().snapshot.revision,
            changed.revision
        );

        let unknown_metadata = OperationAssociation {
            operation_id: "new-lost".into(),
            kind: "new_session".into(),
            connection_id: "host".into(),
            instance_id: "work".into(),
            host_epoch: "epoch".into(),
            runtime_generation: 1,
            session_id: "session-1".into(),
            editor: json!({"textRevision":"unchanged"}),
            state: OperationState::Pending,
            result: None,
            error: None,
        };
        let duplicate = unknown_metadata.clone();
        let unknown_directory = directory.clone();
        let unknown_endpoint = endpoint.clone();
        let unknown = operations
            .execute(unknown_metadata, async move {
                // The isolated peer closes after receiving the mutation.
                let transport = DockClient::new(
                    ConnectionRouter::local(
                        &IdentityStore::new(unknown_directory.join("unknown-identity")),
                        LocalDockEndpoint::configured(unknown_endpoint.to_str().unwrap()).unwrap(),
                        "unknown".into(),
                    )
                    .unwrap(),
                );
                transport.new_session("work", None, Some("new-lost")).await
            })
            .await
            .unwrap();
        assert!(unknown.is_err());
        assert_eq!(operations.pending()[0].state, OperationState::Unknown);
        operations.consume("new-lost");
        assert_eq!(
            operations.pending()[0].state,
            OperationState::Unknown,
            "display refresh/consume cannot establish a missing operation result"
        );
        let replay: crate::Result<std::result::Result<(), ClientError>> = operations
            .execute(duplicate, async { panic!("mutation must not be replayed") })
            .await;
        assert!(replay.is_err());
        service.pause("authority:work:epoch");
        peer.abort();
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn long_tail_rebind_is_batched_and_does_not_block_commits_or_restart_on_lag() {
        use std::time::Instant;
        let directory = std::env::temp_dir().join(format!("tail-{}", uuid::Uuid::new_v4()));
        let content = SessionContent::in_directory(directory.clone()).unwrap();
        let owner = content.claim("work");
        content
            .commit(
                "work",
                owner,
                SessionUpdate::Read(serde_json::from_value(read()).unwrap()),
            )
            .unwrap();
        let event = |sequence, text: String| crate::DockEvent {
            scope: "instance".into(),
            instance_id: "work".into(),
            runtime_generation: 1,
            sequence,
            occurred_at: "now".into(),
            event_type: "message.delta".into(),
            data: json!({"messageId":"assistant", "block":"thinking", "delta":text}),
        };
        for sequence in 11..=9010 {
            content
                .commit(
                    "work",
                    owner,
                    SessionUpdate::Event(event(sequence, "x".repeat(7800))),
                )
                .unwrap();
        }
        let rss = || -> u64 {
            std::fs::read_to_string("/proc/self/status")
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find(|line| line.starts_with("VmRSS:"))
                        .and_then(|line| line.split_whitespace().nth(1))
                        .and_then(|v| v.parse().ok())
                })
                .unwrap_or(0)
        };
        let baseline_rss = rss();
        let start = Instant::now();
        let mut binding = content.bind("work").unwrap();
        let mut held_display = content.bind("work").unwrap();
        let bind_micros = start.elapsed().as_micros();
        let publisher = content.clone();
        let (done, completed) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            for sequence in 9011..=9522 {
                publisher
                    .commit(
                        "work",
                        owner,
                        SessionUpdate::Event(event(sequence, "live".into())),
                    )
                    .unwrap();
            }
            publisher
                .commit(
                    "work",
                    owner,
                    SessionUpdate::Event(crate::DockEvent {
                        event_type: "tool.output_updated".into(),
                        data: json!({"toolCallId":"tool", "text":"中".repeat(200_000)}),
                        ..event(9523, String::new())
                    }),
                )
                .unwrap();
            let mut checkpoint = read();
            checkpoint["instance"]["eventCursor"] = cursor(9523, 1);
            checkpoint["page"]["latest"] = cursor(9523, 1);
            publisher
                .commit(
                    "work",
                    owner,
                    SessionUpdate::Read(serde_json::from_value(checkpoint).unwrap()),
                )
                .unwrap();
            done.send(()).unwrap();
        });
        let mut peak_rss = baseline_rss;
        let mut events = 0;
        let mut completed_before_replay_end = false;
        let mut max_small_batch = 0;
        let mut last_revision = binding.snapshot.revision;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let batch = binding.next_batch().await.unwrap();
                let encoded = serde_json::to_vec(&batch).unwrap().len();
                if encoded > 270_000 {
                    assert_eq!(batch.len(), 1);
                } else {
                    max_small_batch = max_small_batch.max(encoded);
                }
                for commit in &batch {
                    assert!(
                        commit.revision > last_revision
                            || (commit.revision == last_revision
                                && matches!(commit.update, SessionUpdate::Content { .. }))
                    );
                    last_revision = commit.revision;
                    if let SessionUpdate::Event(event) | SessionUpdate::ReplayEvent { event, .. } =
                        &commit.update
                    {
                        events += 1;
                        if event.sequence == 9523 {
                            assert_eq!(event.data["text"].as_str().unwrap().len(), 600_000);
                        }
                    }
                }
                peak_rss = peak_rss.max(rss());
                if completed.try_recv().is_ok() {
                    completed_before_replay_end = events < 9000;
                }
                if events == 9513 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        writer.join().unwrap();
        assert_eq!(
            events, 9513,
            "checkpoint and slow replay neither skip nor duplicate accepted events"
        );
        assert!(
            completed_before_replay_end,
            "publication completes while old tail replay is still progressing"
        );
        #[cfg(target_os = "linux")]
        assert!(
            peak_rss.saturating_sub(baseline_rss) < 16 * 1024,
            "replay memory must not grow by the 64MiB retained tail"
        );
        println!(
            "bind_pair_us={bind_micros} max_small_batch_bytes={max_small_batch} replay_rss_delta_kib={} concurrent_events=513",
            peak_rss.saturating_sub(baseline_rss)
        );
        assert!(
            held_display.take_replacement().is_none(),
            "ordinary lag/checkpoint cannot restart a display from the latest snapshot"
        );
        content
            .replace("work", serde_json::from_value(instance(2)).unwrap(), false)
            .unwrap();
        let priority_start = Instant::now();
        let new_target = held_display.take_replacement().unwrap();
        assert_eq!(new_target.target.unwrap().runtime_generation, 2);
        assert!(new_target.read.is_none());
        println!(
            "replacement_over_undrained_tail_us={}",
            priority_start.elapsed().as_micros()
        );
        let new_owner = content.claim("work");
        let mut fresh = read();
        fresh["instance"] = instance(2);
        fresh["page"]["earliest"] = cursor(10, 2);
        fresh["page"]["latest"] = cursor(10, 2);
        content
            .commit(
                "work",
                new_owner,
                SessionUpdate::Read(serde_json::from_value(fresh).unwrap()),
            )
            .unwrap();
        let next = held_display.next_batch().await.unwrap();
        assert!(
            next.iter().all(|commit| match &commit.update {
                SessionUpdate::Read(read)
                | SessionUpdate::ObservationCut(read)
                | SessionUpdate::Content {
                    update: crate::ContentUpdate::CheckpointBegin { read },
                    ..
                } => read.instance.runtime_generation == 2,
                SessionUpdate::Content { .. } => true,
                _ => false,
            }),
            "old Session replay cannot delay or follow a committed replacement"
        );
        drop(held_display);
        drop(binding);
        drop(content);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn read_replay_and_host_refusal_end_observation_without_network_retry() {
        for mode in ["read", "replay", "refusal"] {
            let directory = std::env::temp_dir().join(format!("terminal-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&directory).unwrap();
            let endpoint = directory.join("dock.sock");
            let listener = tokio::net::UnixListener::bind(&endpoint).unwrap();
            let requests = Arc::new(AtomicUsize::new(0));
            let received = requests.clone();
            let peer = tokio::spawn(async move {
                loop {
                    let (socket, _) = listener.accept().await.unwrap();
                    let mut socket = tokio::io::BufReader::new(socket);
                    received.fetch_add(1, Ordering::SeqCst);
                    let hello: Value = read_json_line(&mut socket, 1048576).await.unwrap();
                    write_json_line(&mut socket,&json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,"host":{"hostEpoch":"epoch"},"capabilities":hello["requiredCapabilities"],"limits":{"maxLineBytes":1048576}})).await.unwrap();
                    let request: Value = read_json_line(&mut socket, 1048576).await.unwrap();
                    if mode == "refusal" {
                        write_json_line(&mut socket,&json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":false,"error":{"code":"instance_not_active","message":"ended","retryable":false}})).await.unwrap();
                    } else {
                        let result = if mode == "read" {
                            assert_eq!(request["type"], "instance.read");
                            let mut result = read();
                            result["instance"]["lifecycle"] = json!("stopped");
                            result["instance"]["execution"] = json!("unavailable");
                            result["instance"]["ownerHostEpoch"] = Value::Null;
                            result
                        } else {
                            assert_eq!(request["type"], "instance.follow");
                            json!({"page":{"events":[{"scope":"instance","instanceId":"work","runtimeGeneration":1,"sequence":11,"occurredAt":"now","type":"instance.stopped","data":{"cleanupErrors":[]}}],"earliest":cursor(10,1),"latest":cursor(11,1),"truncated":false,"epochChanged":false,"generationChanged":false}})
                        };
                        write_json_line(&mut socket,&json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,"result":result})).await.unwrap();
                    }
                }
            });
            let client = DockClient::new(
                ConnectionRouter::local(
                    &IdentityStore::new(directory.join("identity")),
                    LocalDockEndpoint::configured(endpoint.to_str().unwrap()).unwrap(),
                    "terminal".into(),
                )
                .unwrap(),
            );
            let service = ConversationObservation::default();
            if mode == "replay" {
                let owner = service.content.claim("work");
                service
                    .content
                    .commit(
                        "work",
                        owner,
                        SessionUpdate::Read(serde_json::from_value(read()).unwrap()),
                    )
                    .unwrap();
            }
            let mut binding = service
                .bind(
                    "work".into(),
                    client.clone(),
                    "work".into(),
                    "epoch".into(),
                    false,
                )
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2),async {
                loop { let batch = binding.next_batch().await.unwrap();
                    assert!(!batch.iter().any(|commit| matches!(&commit.update,SessionUpdate::Status { state, .. } if state == "connected" || state == "disconnected")));
                    if batch.iter().any(|commit| matches!(&commit.update,SessionUpdate::Status { state, .. } if state == "stopped" || state == "unavailable")) { break; }
                }
            }).await.unwrap();
            service.pause("work");
            let _ = service
                .bind(
                    "work".into(),
                    client.clone(),
                    "work".into(),
                    "epoch".into(),
                    false,
                )
                .unwrap();
            tokio::time::sleep(Duration::from_millis(1700)).await;
            assert_eq!(
                requests.load(Ordering::SeqCst),
                1,
                "{mode}: terminal evidence must not reconnect"
            );
            service.pause("work");
            peer.abort();
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
    // Master-side review: run the production observation wake plus visibility
    // intent, rather than proving image API caching while a background reader
    // silently downloads all image bodies again.
    #[tokio::test]
    async fn observation_reads_visible_text_but_not_unrequested_or_image_only_bodies() {
        let directory = std::env::temp_dir().join(format!(
            "demand-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ));
        std::fs::create_dir(&directory).unwrap();
        let endpoint = directory.join("s");
        let listener = tokio::net::UnixListener::bind(&endpoint).unwrap();
        let histories = Arc::new(AtomicUsize::new(0));
        let bodies = Arc::new(Mutex::new(Vec::<String>::new()));
        let image = json!({"recordId":"image","entryId":"image","kind":"message","source":"tool_result","visibility":"visible","toolCallId":"tool","toolName":"read","content":[{"type":"tool_result","toolCallId":"tool","toolName":"read","text":"","isError":false},{"type":"image","mimeType":"image/png","contentRef":"opaque-image"}]});
        let text = json!({"recordId":"text","entryId":"text","kind":"message","source":"user","visibility":"visible","content":[{"type":"text","text":"preview"}]});
        let peer = {
            let histories = histories.clone();
            let bodies = bodies.clone();
            tokio::spawn(async move {
                loop {
                    let (socket, _) = listener.accept().await.unwrap();
                    let image = image.clone();
                    let text = text.clone();
                    let histories = histories.clone();
                    let bodies = bodies.clone();
                    tokio::spawn(async move {
                        let mut socket = tokio::io::BufReader::new(socket);
                        let hello: Value = read_json_line(&mut socket, 1048576).await.unwrap();
                        write_json_line(&mut socket, &json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,"host":{"hostEpoch":"epoch"},"capabilities":hello["requiredCapabilities"],"limits":{"maxLineBytes":1048576}})).await.unwrap();
                        let request: Value = read_json_line(&mut socket, 1048576).await.unwrap();
                        let result = match request["type"].as_str().unwrap() {
                            "instance.read" => {
                                let mut r = read();
                                r["recentHistory"] = json!([image, text]);
                                r
                            }
                            "instance.follow" => {
                                write_json_line(&mut socket, &json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,"result":{"page":{"events":[],"earliest":cursor(10,1),"latest":cursor(10,1),"truncated":false,"epochChanged":false,"generationChanged":false}}})).await.unwrap();
                                std::future::pending::<()>().await;
                                return;
                            }
                            "conversation.history" => {
                                histories.fetch_add(1, Ordering::SeqCst);
                                json!({"instance":instance(1),"revision":"revision","entries":[{"entry":image,"contentRef":"image-body","contentComplete":false,"totalBlocks":2},{"entry":text,"contentRef":"text-body","contentComplete":false,"totalBlocks":1}],"hasEarlier":false,"nextCursor":null})
                            }
                            "conversation.content.stream" => {
                                let reference =
                                    request["params"]["contentRef"].as_str().unwrap().to_owned();
                                bodies.lock().unwrap().push(reference.clone());
                                if reference == "image-body" {
                                    // Explicit full-record retry reached the native reader;
                                    // no need to emulate image transfer in this demand test.
                                    write_json_line(&mut socket, &json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":false,"error":{"code":"not_found","message":"fixture body unavailable","retryable":false}})).await.unwrap();
                                    return;
                                }
                                use sha2::Digest;
                                use crate::file_io::{FileActivity, write_file_record};
                                let activity = FileActivity::new();
                                let metadata = json!({"runtimeGeneration":1,"revision":"revision","contentRef":reference});
                                let bytes = format!("{}\n", json!({"type":"text","blockIndex":0,"text":"complete necessary text".repeat(300),"offset":0,"blockComplete":true})).into_bytes();
                                let sha = hex::encode(sha2::Sha256::digest(&bytes));
                                write_file_record(&mut socket, &json!({"kind":"file_ready","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","direction":"download","maxChunkBytes":65536,"windowBytes":262144,"metadata":metadata}), &activity).await.unwrap();
                                write_file_record(&mut socket, &json!({"kind":"file_chunk","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","index":0,"data":base64::Engine::encode(&base64::engine::general_purpose::STANDARD,&bytes)}), &activity).await.unwrap();
                                loop {
                                    let progress: Value = read_json_line(&mut socket, 1048576).await.unwrap();
                                    if progress["consumedBytes"] == bytes.len() { break; }
                                }
                                write_file_record(&mut socket, &json!({"kind":"file_complete","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","chunks":1,"sizeBytes":bytes.len(),"sha256":sha}), &activity).await.unwrap();
                                json!({"instanceId":"work","runtimeGeneration":1,"revision":"revision","contentRef":reference,"chunks":1,"sizeBytes":bytes.len(),"sha256":sha})
                            }
                            other => panic!("unexpected request {other}"),
                        };
                        write_json_line(&mut socket, &json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,"result":result})).await.unwrap();
                    });
                }
            })
        };
        let client = DockClient::new(
            ConnectionRouter::local(
                &IdentityStore::new(directory.join("identity")),
                LocalDockEndpoint::configured(endpoint.to_str().unwrap()).unwrap(),
                "demand".into(),
            )
            .unwrap(),
        );
        let service = ConversationObservation::new(
            SessionContent::in_directory(directory.join("cache")).unwrap(),
        );
        let mut binding = service
            .bind(
                "work".into(),
                client.clone(),
                "work".into(),
                "epoch".into(),
                false,
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while service.content.content_token("work").is_none()
                || service
                    .content
                    .body_target("work", &service.content.content_token("work").unwrap())
                    .is_none()
            {
                tokio::task::yield_now().await;
            }
            while binding.snapshot.read.is_none() {
                binding.next_batch().await.unwrap();
                binding = service.content.bind("work").unwrap();
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(
            histories.load(Ordering::SeqCst),
            0,
            "opening Work does not scan every incomplete record"
        );
        assert!(bodies.lock().unwrap().is_empty());
        let token = service.content.content_token("work").unwrap();
        service.content.set_read_interest(
            "work",
            &token,
            client.clone(),
            vec!["image".into()],
            false,
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            while histories.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(
            bodies.lock().unwrap().is_empty(),
            "the image-only tool identity does not demand full image base64"
        );
        service.content.set_read_interest(
            "work",
            &token,
            client.clone(),
            vec!["text".into()],
            false,
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let record = next_content_record(&mut binding).await;
                if record.entry_id == "text" && matches!(&record.content[0], crate::ContentBlock::Text { text } if text == &"complete necessary text".repeat(300)) { break; }
            }
        }).await.unwrap();
        assert_eq!(*bodies.lock().unwrap(), ["text-body"]);
        service
            .content
            .set_read_interest("work", &token, client, vec!["image".into()], true);
        tokio::time::timeout(Duration::from_secs(3), async {
            while bodies.lock().unwrap().len() < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(*bodies.lock().unwrap(), ["text-body", "image-body"]);
        service.pause("work");
        peer.abort();
        drop(binding);
        drop(service);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn recovery_read_prioritizes_new_identity_over_unread_tail() {
        for (generation, session_id) in [(2, "session-2"), (1, "other-session")] {
            let directory = std::env::temp_dir().join(format!("read-cut-{}", uuid::Uuid::new_v4()));
            let content = SessionContent::in_directory(directory.clone()).unwrap();
            let owner = content.claim("work");
            content
                .commit(
                    "work",
                    owner,
                    SessionUpdate::Read(serde_json::from_value(read()).unwrap()),
                )
                .unwrap();
            let mut display = content.bind("work").unwrap();
            content
                .commit(
                    "work",
                    owner,
                    SessionUpdate::Event(crate::DockEvent {
                        scope: "instance".into(),
                        instance_id: "work".into(),
                        runtime_generation: 1,
                        sequence: 11,
                        occurred_at: "now".into(),
                        event_type: "message.delta".into(),
                        data: json!({"messageId":"old","block":"text","delta":"old tail"}),
                    }),
                )
                .unwrap();
            let mut fresh = read();
            fresh["instance"] = instance(generation);
            fresh["instance"]["executor"]["piSessionId"] = json!(session_id);
            fresh["instance"]["eventCursor"] = cursor(20, generation);
            fresh["page"]["earliest"] = cursor(20, generation);
            fresh["page"]["latest"] = cursor(20, generation);
            fresh["recentHistory"] = json!([{"recordId":"new","entryId":"new","kind":"message","source":"user","visibility":"conversation","content":[{"type":"text","text":"new read retained"}]}]);
            content
                .commit(
                    "work",
                    owner,
                    SessionUpdate::Read(serde_json::from_value(fresh.clone()).unwrap()),
                )
                .unwrap();
            let replacement = display
                .take_replacement()
                .expect("recovery Read is a real replacement, not an ordinary checkpoint");
            assert_eq!(
                replacement.target.unwrap().executor.pi_session_id,
                session_id
            );
            assert_eq!(next_content_record(&mut display).await.entry_id, "new");
            assert!(
                content.owns("work", owner),
                "the current observer must continue the accepted new read"
            );
            fresh["instance"]["eventCursor"] = cursor(21, generation);
            fresh["page"]["latest"] = cursor(21, generation);
            content
                .commit(
                    "work",
                    owner,
                    SessionUpdate::Read(serde_json::from_value(fresh).unwrap()),
                )
                .unwrap();
            assert!(
                display.take_replacement().is_none(),
                "same-domain checkpoint cannot clear or restart this display"
            );
            let following = display.next_batch().await.unwrap();
            assert!(following.iter().all(|commit| match &commit.update {
                SessionUpdate::Read(read)
                | SessionUpdate::ObservationCut(read)
                | SessionUpdate::Content {
                    update: crate::ContentUpdate::CheckpointBegin { read },
                    ..
                } => read.instance.executor.pi_session_id == session_id,
                SessionUpdate::Content { .. } => true,
                _ => false,
            }));
            drop(display);
            drop(content);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    // Settled checkpoint and navigation bootstrap share one current owner. A
    // late foreground reply must neither end Follow nor skip a missing read.
    #[tokio::test]
    async fn overlapping_network_reads_continue_follow_from_the_accepted_checkpoint() {
        for newer_checkpoint in [true, false] {
            let directory =
                std::env::temp_dir().join(format!("read-race-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&directory).unwrap();
            let endpoint = directory.join("dock.sock");
            let listener = tokio::net::UnixListener::bind(&endpoint).unwrap();
            let reads = Arc::new(AtomicUsize::new(0));
            let follows = Arc::new(AtomicUsize::new(0));
            let bg_started = Arc::new(tokio::sync::Notify::new());
            let fg_started = Arc::new(tokio::sync::Notify::new());
            let release_bg = Arc::new(tokio::sync::Notify::new());
            let release_fg = Arc::new(tokio::sync::Notify::new());
            let (r, f, bg, fg, rb, rf) = (
                reads.clone(),
                follows.clone(),
                bg_started.clone(),
                fg_started.clone(),
                release_bg.clone(),
                release_fg.clone(),
            );
            let peer = tokio::spawn(async move {
                loop {
                    let (socket, _) = listener.accept().await.unwrap();
                    let mut socket = tokio::io::BufReader::new(socket);
                    let (r, f, bg, fg, rb, rf) = (
                        r.clone(),
                        f.clone(),
                        bg.clone(),
                        fg.clone(),
                        rb.clone(),
                        rf.clone(),
                    );
                    tokio::spawn(async move {
                        let hello: Value = read_json_line(&mut socket, 1048576).await.unwrap();
                        write_json_line(&mut socket,&json!({"kind":"hello_ack","version":2,"requestId":hello["requestId"],"catalogSchemaVersion":1,"host":{"hostEpoch":"epoch"},"capabilities":hello["requiredCapabilities"],"limits":{"maxLineBytes":1048576}})).await.unwrap();
                        let request: Value = read_json_line(&mut socket, 1048576).await.unwrap();
                        if request["type"] == "instance.read" {
                            let index = r.fetch_add(1, Ordering::SeqCst);
                            let sequence = match index {
                                0 => 10,
                                1 => {
                                    bg.notify_one();
                                    rb.notified().await;
                                    if newer_checkpoint { 14 } else { 11 }
                                }
                                2 => {
                                    fg.notify_one();
                                    rf.notified().await;
                                    if newer_checkpoint { 13 } else { 11 }
                                }
                                3 if !newer_checkpoint => 14,
                                _ => panic!("unexpected extra read"),
                            };
                            let mut result = read();
                            result["instance"]["eventCursor"] = cursor(sequence, 1);
                            result["page"]["latest"] = cursor(sequence, 1);
                            write_json_line(&mut socket,&json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,"result":result})).await.unwrap();
                        } else {
                            assert_eq!(request["type"], "instance.follow");
                            let index = f.fetch_add(1, Ordering::SeqCst);
                            assert!(index < 2, "no rebind or extra recovery is needed");
                            let sequence = if index == 0 { 10 } else { 14 };
                            assert_eq!(
                                request["params"]["since"]["sequence"], sequence,
                                "Follow must use accepted read, not the rejected response"
                            );
                            write_json_line(&mut socket,&json!({"kind":"response","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","ok":true,"result":{"page":{"events":[],"earliest":cursor(sequence,1),"latest":cursor(sequence,1),"truncated":false,"epochChanged":false,"generationChanged":false}}})).await.unwrap();
                            let event = |sequence, kind, data| json!({"kind":"event","version":2,"requestId":request["requestId"],"hostEpoch":"epoch","event":{"scope":"instance","instanceId":"work","runtimeGeneration":1,"sequence":sequence,"occurredAt":"now","type":kind,"data":data}});
                            if index == 0 {
                                write_json_line(
                                    &mut socket,
                                    &event(11, "run.settled", json!({"result":"succeeded"})),
                                )
                                .await
                                .unwrap();
                                bg.notified().await;
                                write_json_line(
                                    &mut socket,
                                    &event(
                                        12,
                                        "session.navigated",
                                        json!({"targetId":"branch","summaryCreated":false}),
                                    ),
                                )
                                .await
                                .unwrap();
                            } else {
                                write_json_line(
                                    &mut socket,
                                    &event(
                                        15,
                                        "extension.status_changed",
                                        json!({"key":"phase","text":"continued"}),
                                    ),
                                )
                                .await
                                .unwrap();
                                std::future::pending::<()>().await;
                            }
                        }
                    });
                }
            });
            let client = DockClient::new(
                ConnectionRouter::local(
                    &IdentityStore::new(directory.join("identity")),
                    LocalDockEndpoint::configured(endpoint.to_str().unwrap()).unwrap(),
                    "read-race".into(),
                )
                .unwrap(),
            );
            let service = ConversationObservation::default();
            let mut binding = service
                .bind("work".into(), client, "work".into(), "epoch".into(), false)
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2), fg_started.notified())
                .await
                .unwrap();
            release_bg.notify_one();
            if newer_checkpoint {
                tokio::time::timeout(Duration::from_secs(2),async {
                    loop { if binding.next_batch().await.unwrap().iter().any(|commit|matches!(&commit.update,SessionUpdate::Read(read) if read.page.latest.sequence==14)) {break;} }
                }).await.unwrap();
            }
            release_fg.notify_one();
            tokio::time::timeout(Duration::from_secs(3),async {
                loop {if binding.next_batch().await.unwrap().iter().any(|commit|matches!(&commit.update,SessionUpdate::Event(event) if event.sequence==15)) {break;}}
            }).await.unwrap();
            assert_eq!(follows.load(Ordering::SeqCst), 2);
            assert_eq!(
                reads.load(Ordering::SeqCst),
                if newer_checkpoint { 3 } else { 4 }
            );
            service.pause("work");
            peer.abort();
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}
