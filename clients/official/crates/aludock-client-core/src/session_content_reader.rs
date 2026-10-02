//! Local content reads. No display state and no second record collection: only
//! temporary request results and shared versions awaiting SessionContent admission.
use crate::{
    ClientError, ConversationReadContext, DockClient, InstanceSnapshot, Result, SessionContent,
    session_records::RecordVersion,
};

use crate::session_content::{ReadArea, ReadFailure};
use std::collections::{HashMap, HashSet};
// Request target, not a limit on a returned complete tool group.
const HISTORY_PAGE_TARGET: u16 = 50;
#[derive(Clone)]
struct Descriptor {
    context: ConversationReadContext,
    reference: String,
    revision: String,
    blocks: usize,
    needs_body: bool,
    metadata: RecordVersion,
}
#[derive(Default)]
pub(crate) struct BodyReads {
    running: bool,
    pub(crate) paused: bool,
    scanning: bool,
    cursor: Option<String>,
    context: ConversationReadContext,
    scan_done: bool,
    locator_generation: u64,
    seen_cursors: HashSet<String>,
    descriptors: HashMap<String, Descriptor>,
    active: HashSet<String>,
    errors: HashSet<String>,
    retried: HashSet<String>,
    interest: Vec<String>,
    full_requests: HashSet<String>,
}
impl BodyReads {
    fn wants_body(&self, record: &RecordVersion) -> bool {
        (self.interest.contains(&record.entry_id) || self.full_requests.contains(&record.entry_id))
            && !record.complete
            && (self.full_requests.contains(&record.entry_id)
                || self
                    .descriptors
                    .get(&record.entry_id)
                    .is_none_or(|descriptor| descriptor.needs_body))
    }

    pub(crate) fn errors_remove(&mut self, id: &str, complete: bool) {
        self.errors.remove(id);
        if complete {
            self.full_requests.remove(id);
        }
    }
    pub(crate) fn locator_matches(&self, generation: u64) -> bool {
        self.locator_generation == generation
    }
    fn reset_locator(&mut self) {
        self.cursor = None;
        self.context = ConversationReadContext::default();
        self.scan_done = false;
        self.locator_generation += 1;
        self.seen_cursors.clear();
    }
    pub fn states(&self) -> Vec<crate::ContentUpdate> {
        self.active
            .iter()
            .map(|id| crate::ContentUpdate::EntryState {
                entry_id: id.clone(),
                loading: true,
                error: None,
            })
            .chain(
                self.errors
                    .iter()
                    .map(|id| crate::ContentUpdate::EntryState {
                        entry_id: id.clone(),
                        loading: false,
                        error: Some("这部分内容暂时无法读取，请重试。".into()),
                    }),
            )
            .collect()
    }
}
enum BodyWork {
    Scan(Option<String>, u64, ConversationReadContext),
    Body(RecordVersion, Descriptor),
}
enum BodyResult {
    Page(
        u64,
        ConversationReadContext,
        Result<(crate::ConversationHistoryPage, String)>,
    ),
    Body(String, Result<RecordVersion>),
}

// Reference-view completeness includes image identities, not image downloads.
// The legacy fallback still uses this image-only check to leave bytes to media.
// A tool's empty result block is identity, not a demand for image base64.
fn descriptor_needs_body(item: &crate::ConversationHistoryEntry) -> bool {
    use crate::ContentBlock;
    !item.content_complete
        && (item.total_blocks > item.entry.content.len()
            || item.entry.content.iter().any(|block| match block {
                ContentBlock::Image { .. } => false,
                ContentBlock::ToolResult {
                    text,
                    omitted_fields,
                    ..
                } => !text.is_empty() || !omitted_fields.is_empty(),
                _ => true,
            }))
}

async fn cache_records(
    records: Vec<crate::HistoryRecord>,
    complete: bool,
) -> Result<Vec<RecordVersion>> {
    tokio::task::spawn_blocking(move || {
        records
            .iter()
            .map(|record| RecordVersion::new(record, complete))
            .collect()
    })
    .await
    .map_err(|error| ClientError::Protocol(format!("local record encoder interrupted: {error}")))?
}
fn same_target(actual: &InstanceSnapshot, expected: &InstanceSnapshot, epoch: &str) -> bool {
    actual.id == expected.id
        && actual.runtime_generation == expected.runtime_generation
        && actual.executor.pi_session_id == expected.executor.pi_session_id
        && actual.owner_host_epoch.as_deref() == Some(epoch)
        && expected.owner_host_epoch.as_deref() == Some(epoch)
}
impl SessionContent {
    /// Visibility is demand, not a new content identity. Existing complete bodies
    /// are reused, pending requests are shared, and only this native runner owns
    /// descriptor locations or chooses a recovery read.
    pub fn set_read_interest(
        &self,
        key: &str,
        token: &str,
        client: DockClient,
        entry_ids: Vec<String>,
        retry: bool,
    ) {
        let mut cleared = Vec::new();
        let start = self
            .body_access(key, token, |reads, members| {
                reads.paused = false;
                let entry_ids: Vec<_> = entry_ids
                    .into_iter()
                    .filter(|id| members.iter().any(|record| &record.entry_id == id))
                    .collect();
                if retry {
                    reads.full_requests.extend(if entry_ids.is_empty() {
                        reads.errors.iter().cloned().collect()
                    } else {
                        entry_ids.clone()
                    });
                    cleared = reads
                        .errors
                        .iter()
                        .filter(|id| entry_ids.is_empty() || entry_ids.contains(id))
                        .cloned()
                        .collect();
                    for id in &cleared {
                        reads.errors.remove(id);
                        reads.retried.remove(id);
                        reads.descriptors.remove(id);
                    }
                    reads.retried.remove("");
                    reads.reset_locator();
                } else {
                    reads.interest = entry_ids;
                }
                if reads.scan_done
                    && members.iter().any(|record| {
                        reads.wants_body(record)
                            && !reads.errors.contains(&record.entry_id)
                            && !reads.descriptors.contains_key(&record.entry_id)
                    })
                {
                    reads.reset_locator();
                }
                !std::mem::replace(&mut reads.running, true)
            })
            .unwrap_or(false);
        for id in cleared {
            let _ = self.body_status(key, token, &id, false, None);
        }
        if start {
            self.spawn_body_reader(key, token, client);
        }
    }
    pub(crate) fn wake_body_reader(&self, key: &str, token: &str, client: DockClient) {
        let start = self
            .body_access(key, token, |reads, _| {
                !reads.paused && !std::mem::replace(&mut reads.running, true)
            })
            .unwrap_or(false);
        if start {
            self.spawn_body_reader(key, token, client);
        }
    }
    fn spawn_body_reader(&self, key: &str, token: &str, client: DockClient) {
        let (service, key, token) = (self.clone(), key.to_owned(), token.to_owned());
        tokio::spawn(async move {
            service.run_bodies(key, token, client).await;
        });
    }
    async fn run_bodies(&self, key: String, token: String, client: DockClient) {
        let Some(target) = self
            .body_target(&key, &token)
            .filter(|target| target.lifecycle == crate::InstanceLifecycle::Active)
        else {
            self.body_access(&key, &token, |reads, _| reads.running = false);
            return;
        };
        let mut jobs = tokio::task::JoinSet::new();
        loop {
            while jobs.len() < 2 {
                let work = self
                    .body_access(&key, &token, |reads, members| {
                        if reads.paused {
                            return None;
                        }
                        let mut pending: Vec<_> = members
                            .iter()
                            .filter(|record| {
                                reads.wants_body(record)
                                    && !reads.active.contains(&record.entry_id)
                                    && !reads.errors.contains(&record.entry_id)
                            })
                            .collect();
                        pending.sort_by_key(|record| {
                            reads
                                .interest
                                .iter()
                                .position(|id| id == &record.entry_id)
                                .unwrap_or(usize::MAX)
                        });
                        for record in &pending {
                            if let Some(descriptor) = reads.descriptors.get(&record.entry_id) {
                                reads.active.insert(record.entry_id.clone());
                                return Some(BodyWork::Body(
                                    descriptor.metadata.clone(),
                                    descriptor.clone(),
                                ));
                            }
                        }
                        if !pending.is_empty() && !reads.scanning && !reads.scan_done {
                            reads.scanning = true;
                            return Some(BodyWork::Scan(
                                reads.cursor.clone(),
                                reads.locator_generation,
                                reads.context,
                            ));
                        }
                        None
                    })
                    .flatten();
                let Some(work) = work else { break };
                let client = client.clone();
                let target = target.clone();
                match work {
                    BodyWork::Scan(cursor, generation, mut context) => {
                        jobs.spawn(async move {
                            let result = client
                                .conversation_history(
                                    &target.id,
                                    cursor.as_deref(),
                                    HISTORY_PAGE_TARGET,
                                    &mut context,
                                )
                                .await;
                            BodyResult::Page(generation, context, result)
                        });
                    }
                    BodyWork::Body(version, descriptor) => {
                        let _ = self.body_status(&key, &token, &version.entry_id, true, None);
                        let content = self.clone();
                        let authority = key.clone();
                        jobs.spawn(async move {
                            let id = version.entry_id.clone();
                            let result = async {
                                let mut record =
                                    tokio::task::spawn_blocking(move || version.read())
                                        .await
                                        .map_err(|error| {
                                            ClientError::Protocol(format!(
                                                "local record reader interrupted: {error}"
                                            ))
                                        })??;
                                let preview = record.content.clone();
                                record.content = client
                                    .hydrate_content(
                                        &target.id,
                                        target.owner_host_epoch.as_deref().unwrap_or_default(),
                                        target.runtime_generation,
                                        &descriptor.revision,
                                        &descriptor.reference,
                                        descriptor.blocks,
                                        descriptor.context,
                                    )
                                    .await?;
                                restore_body_metadata(&preview, &mut record.content);
                                tokio::task::spawn_blocking(move || {
                                    content.prepare_complete_record(&authority, &target, record)
                                })
                                .await
                                .map_err(|error| {
                                    ClientError::Protocol(format!(
                                        "local body writer interrupted: {error}"
                                    ))
                                })?
                            }
                            .await;
                            BodyResult::Body(id, result)
                        });
                    }
                }
            }
            let Some(result) = jobs.join_next().await else {
                let more = self
                    .body_access(&key, &token, |reads, members| {
                        let pending = !reads.paused
                            && members.iter().any(|record| {
                                reads.wants_body(record)
                                    && !reads.errors.contains(&record.entry_id)
                                    && (reads.descriptors.contains_key(&record.entry_id)
                                        || !reads.scan_done)
                            });
                        if !pending {
                            reads.running = false;
                        }
                        pending
                    })
                    .unwrap_or(false);
                if more {
                    continue;
                }
                return;
            };
            let result = match result {
                Ok(result) => result,
                Err(error) => {
                    let generation = self
                        .body_access(&key, &token, |reads, members| {
                            reads.running = false;
                            reads.scanning = false;
                            reads.active.clear();
                            reads.scan_done = true;
                            for record in members.iter().filter(|record| !record.complete) {
                                reads.errors.insert(record.entry_id.clone());
                            }
                            reads.locator_generation
                        })
                        .unwrap_or_default();
                    let _ = self.content_failure(
                        &key,
                        &token,
                        ReadFailure::Descriptors(generation),
                        &ClientError::Protocol(format!("local content task interrupted: {error}")),
                    );
                    return;
                }
            };
            match result {
                BodyResult::Page(generation, context, result) => {
                    let current = self
                        .body_access(&key, &token, |reads, _| {
                            reads.scanning = false;
                            reads.locator_generation == generation
                        })
                        .unwrap_or(false);
                    if !current {
                        continue;
                    }
                    match result {
                        Ok((page, epoch)) if same_target(&page.instance, &target, &epoch) => {
                            let advances = self
                                .body_access(&key, &token, |reads, _| {
                                    reads.retried.remove("");
                                    page.next_cursor.as_ref().is_none_or(|cursor| {
                                        reads.seen_cursors.insert(cursor.clone())
                                    })
                                })
                                .unwrap_or(false);
                            if !advances {
                                self.body_access(&key, &token, |reads, _| reads.scan_done = true);
                                let _ = self.content_failure(
                                    &key,
                                    &token,
                                    ReadFailure::Descriptors(generation),
                                    &ClientError::Protocol("descriptor cursor repeated".into()),
                                );
                                continue;
                            }
                            let _ =
                                self.clear_content_error(&key, &token, Some(ReadArea::Descriptors));
                            let current = self
                                .body_access(&key, &token, |reads, _| {
                                    if reads.locator_generation != generation {
                                        return false;
                                    }
                                    reads.cursor = page.next_cursor.clone();
                                    reads.context = context;
                                    reads.scan_done = !page.has_earlier;
                                    true
                                })
                                .unwrap_or(false);
                            if !current {
                                continue;
                            }
                            for item in page.entries {
                                let wanted = self
                                    .body_access(&key, &token, |reads, members| {
                                        reads.locator_generation == generation
                                            && members.iter().any(|record| {
                                                record.entry_id == item.entry.entry_id
                                                    && !record.complete
                                            })
                                    })
                                    .unwrap_or(false);
                                if !wanted {
                                    continue;
                                }
                                let id = item.entry.entry_id.clone();
                                let needs_body = descriptor_needs_body(&item);
                                let version = if item.content_complete {
                                    let (content, authority, target) =
                                        (self.clone(), key.clone(), target.clone());
                                    tokio::task::spawn_blocking(move || {
                                        content.prepare_complete_record(
                                            &authority, &target, item.entry,
                                        )
                                    })
                                    .await
                                    .map_err(|error| {
                                        ClientError::Protocol(format!(
                                            "local body writer interrupted: {error}"
                                        ))
                                    })
                                    .and_then(|result| result)
                                } else {
                                    cache_records(vec![item.entry], false)
                                        .await
                                        .map(|mut records| records.remove(0))
                                };
                                match version {
                                    Ok(version) => {
                                        let current = self
                                            .body_access(&key, &token, |reads, _| {
                                                if reads.locator_generation != generation {
                                                    return false;
                                                }
                                                if !item.content_complete {
                                                    reads.descriptors.insert(
                                                        id.clone(),
                                                        Descriptor {
                                                            context,
                                                            reference: item.content_ref,
                                                            revision: page.revision.clone(),
                                                            blocks: item.total_blocks,
                                                            needs_body,
                                                            metadata: version.clone(),
                                                        },
                                                    );
                                                }
                                                true
                                            })
                                            .unwrap_or(false);
                                        if !current {
                                            continue;
                                        }
                                        if let Err(error) = self.publish_body(&key, &token, version)
                                        {
                                            let _ = self.content_failure(
                                                &key,
                                                &token,
                                                ReadFailure::Descriptors(generation),
                                                &error,
                                            );
                                        } else if item.content_complete {
                                            let _ =
                                                self.body_status(&key, &token, &id, false, None);
                                        }
                                    }
                                    Err(error) => {
                                        let _ = self.content_failure(
                                            &key,
                                            &token,
                                            ReadFailure::Descriptors(generation),
                                            &error,
                                        );
                                    }
                                }
                            }
                            if !page.has_earlier {
                                let missing = self
                                    .body_access(&key, &token, |reads, members| {
                                        if reads.locator_generation != generation {
                                            return Vec::new();
                                        }
                                        let ids: Vec<_> = members
                                            .iter()
                                            .filter(|record| {
                                                reads.wants_body(record)
                                                    && !reads
                                                        .descriptors
                                                        .contains_key(&record.entry_id)
                                                    && !reads.active.contains(&record.entry_id)
                                            })
                                            .map(|record| record.entry_id.clone())
                                            .collect();
                                        for id in &ids {
                                            reads.errors.insert(id.clone());
                                        }
                                        ids
                                    })
                                    .unwrap_or_default();
                                for id in missing {
                                    let _ = self.body_status(
                                        &key,
                                        &token,
                                        &id,
                                        false,
                                        Some("这部分内容暂时无法读取，请重试。".into()),
                                    );
                                }
                            }
                        }
                        result => {
                            let error = result.err().unwrap_or_else(|| {
                                ClientError::Protocol("descriptor target changed".into())
                            });
                            let retry = self
                                .body_access(&key, &token, |reads, _| {
                                    if reads.locator_generation != generation {
                                        return true;
                                    }
                                    if reads.retried.insert(String::new()) {
                                        reads.reset_locator();
                                        true
                                    } else {
                                        reads.scan_done = true;
                                        false
                                    }
                                })
                                .unwrap_or(false);
                            if !retry {
                                let _ = self.content_failure(
                                    &key,
                                    &token,
                                    ReadFailure::Descriptors(generation),
                                    &error,
                                );
                            }
                        }
                    }
                }
                BodyResult::Body(id, result) => {
                    self.body_access(&key, &token, |reads, _| {
                        reads.active.remove(&id);
                    });
                    let result = result.and_then(|record| self.publish_body(&key, &token, record));
                    match result {
                        Ok(_) => {
                            let _ = self.body_status(&key, &token, &id, false, None);
                        }
                        Err(error) => {
                            let stale = matches!(&error, ClientError::Protocol(_))
                                || matches!(&error, ClientError::Host { code, .. } if code == "invalid_cursor");
                            let retry = self
                                .body_access(&key, &token, |reads, _| {
                                    if stale && reads.retried.insert(id.clone()) {
                                        reads.descriptors.remove(&id);
                                        reads.reset_locator();
                                        true
                                    } else {
                                        reads.errors.insert(id.clone());
                                        false
                                    }
                                })
                                .unwrap_or(false);
                            let message = if matches!(error, ClientError::Storage { .. }) {
                                "本地内容暂时无法保存，请检查可用空间后重试。"
                            } else {
                                "这部分内容暂时无法读取，请重试。"
                            };
                            let _ = self.body_status(
                                &key,
                                &token,
                                &id,
                                false,
                                (!retry).then(|| message.into()),
                            );
                        }
                    }
                }
            }
        }
    }

    fn prepare_complete_record(
        &self,
        authority: &str,
        target: &InstanceSnapshot,
        record: crate::HistoryRecord,
    ) -> Result<RecordVersion> {
        let mut value = serde_json::to_value(&record)?;
        for block in value["content"].as_array_mut().expect("record content") {
            if block["type"] != "image" {
                continue;
            }
            let Some(data) = block["data"].as_str() else {
                continue;
            };
            let mime = block["mimeType"].as_str().unwrap_or_default();
            let image = self.inline_image(
                crate::MediaScope {
                    authority: authority.into(),
                    instance_id: target.id.clone(),
                    host_epoch: target.owner_host_epoch.clone().unwrap_or_default(),
                    runtime_generation: target.runtime_generation,
                },
                mime,
                data,
            )?;
            if block["fileId"].is_null() {
                let matches: Vec<_> = record
                    .attachments
                    .iter()
                    .filter(|attachment| {
                        attachment.sha256 == image.sha256
                            && attachment.size_bytes == image.size_bytes
                    })
                    .collect();
                if matches.len() == 1 {
                    block["fileId"] = matches[0].file_id.clone().into();
                }
            }
            block.as_object_mut().unwrap().remove("data");
            block["nativeMedia"] = serde_json::to_value(image)?;
        }
        RecordVersion::from_value(&record.entry_id, &value, true)
    }
    pub async fn retry_content(
        &self,
        key: &str,
        token: &str,
        client: &DockClient,
        entry_ids: Vec<String>,
    ) -> Result<()> {
        let (service, key, token, client) = (
            self.clone(),
            key.to_owned(),
            token.to_owned(),
            client.clone(),
        );
        tokio::spawn(async move {
            if service.content_token(&key).as_deref() != Some(token.as_str()) {
                return Ok(());
            }
            let retry_earlier = service.should_retry_earlier(&key, &token);
            service.clear_content_error(&key, &token, None)?;
            service.set_read_interest(&key, &token, client.clone(), entry_ids, true);
            if retry_earlier {
                service.load_earlier(&key, &token, &client).await?;
            }
            if service.content_token(&key).as_deref() != Some(token.as_str()) {
                return Ok(());
            }
            service.reconcile_checkpoint(&key, &client).await?;
            Ok(())
        })
        .await
        .map_err(|error| {
            ClientError::Protocol(format!("content retry task interrupted: {error}"))
        })?
    }
    /// The displayed lower boundary, not a descriptor page's cursor, chooses the
    /// request. Concurrent clicks share the native in-flight state.
    pub async fn load_earlier(&self, key: &str, token: &str, client: &DockClient) -> Result<()> {
        let Some((target, anchor)) = self.earlier_request(key, token)? else {
            return Ok(());
        };
        let (service, key, token, client) = (
            self.clone(),
            key.to_owned(),
            token.to_owned(),
            client.clone(),
        );
        tokio::spawn(async move {
            service
                .read_earlier(&key, &token, &client, target, anchor)
                .await
        })
        .await
        .map_err(|error| {
            ClientError::Protocol(format!("earlier content task interrupted: {error}"))
        })?
    }
    async fn read_earlier(
        &self,
        key: &str,
        token: &str,
        client: &DockClient,
        target: InstanceSnapshot,
        anchor: String,
    ) -> Result<()> {
        let result = async {
            let (page, epoch) = client
                .session_history(&target.id, Some(&anchor), HISTORY_PAGE_TARGET)
                .await?;
            if !same_target(&page.instance, &target, &epoch) {
                return Err(ClientError::Protocol(
                    "history target changed during a local read".into(),
                ));
            }
            let records = cache_records(page.entries, false).await?;
            self.finish_earlier(key, token, &anchor, records, page.has_earlier)?;
            self.wake_body_reader(key, token, client.clone());
            Ok(())
        }
        .await;
        if let Err(error) = &result {
            if !self.content_failure(key, token, ReadFailure::Earlier, error)? {
                return Ok(());
            }
        }
        result
    }
    /// A Read's remote cut can advance Follow while its content coverage is
    /// pending. Only an authoritative interval may retire the old raw prefix.
    pub async fn reconcile_checkpoint(&self, key: &str, client: &DockClient) -> Result<()> {
        let Some(token) = self.begin_coverage(key) else {
            return Ok(());
        };
        let (service, key, client) = (self.clone(), key.to_owned(), client.clone());
        tokio::spawn(async move {
            loop {
                let result = service.reconcile_candidate(&key, &client, &token).await;
                if !service.end_coverage(&key, &token, result.is_ok()) {
                    return result;
                }
            }
        })
        .await
        .map_err(|error| {
            ClientError::Protocol(format!("content coverage task interrupted: {error}"))
        })?
    }
    async fn reconcile_candidate(
        &self,
        key: &str,
        client: &DockClient,
        expected_token: &str,
    ) -> Result<()> {
        let Some((token, pending, previous, previous_has_earlier)) = self.checkpoint_request(key)
        else {
            return Ok(());
        };
        if token != expected_token {
            return Ok(());
        }
        let requested_revision = pending.revision;
        let result = async {
            let read = pending.read;
            let target = &read.instance;
            let mut records = pending.records;
            let mut has_earlier = read.history_truncated;
            // The oldest already seen member proves the whole retained range,
            // including records previously present only in the raw tail. A
            // missing old anchor is not a branch decision: scan the actual branch
            // to its beginning and use that authoritative membership instead.
            let oldest = previous.first().map(|record| record.entry_id.as_str());
            loop {
                if let Some(index) = records
                    .iter()
                    .position(|record| Some(record.entry_id.as_str()) == oldest)
                {
                    records.drain(..index);
                    has_earlier = previous_has_earlier;
                    break;
                }
                if !has_earlier {
                    break;
                }
                let Some(first) = records.first() else {
                    return Err(ClientError::Protocol(
                        "truncated checkpoint has no history anchor".into(),
                    ));
                };
                let (page, epoch) = client
                    .session_history(&target.id, Some(&first.entry_id), HISTORY_PAGE_TARGET)
                    .await?;
                if !same_target(&page.instance, target, &epoch) {
                    return Err(ClientError::Protocol(
                        "checkpoint target changed during coverage read".into(),
                    ));
                }
                if page.entries.is_empty() && page.has_earlier {
                    return Err(ClientError::Protocol(
                        "history did not advance its anchored interval".into(),
                    ));
                }
                let mut prefix = cache_records(page.entries, false).await?;
                prefix.extend(records);
                records = prefix;
                has_earlier = page.has_earlier;
            }
            if let Some(accepted) =
                self.finish_checkpoint(key, &token, pending.revision, oldest, records, has_earlier)?
            {
                self.wake_body_reader(key, &accepted, client.clone());
            }
            Ok(())
        }
        .await;
        if let Err(error) = &result {
            if !self.content_failure(
                key,
                &token,
                ReadFailure::Coverage(requested_revision),
                error,
            )? {
                return Ok(());
            }
        }
        result
    }
}

// Previews may remove text blocks. Match the ordered image subsequence only
// when it is complete; never zip preview indices against complete block indices.
fn restore_body_metadata(preview: &[crate::ContentBlock], content: &mut [crate::ContentBlock]) {
    use crate::ContentBlock::{Image, ToolResult};
    for block in content.iter_mut() {
        if let ToolResult {
            tool_call_id,
            tool_name,
            presentation,
            nested_calls,
            ..
        } = block
        {
            if let Some(ToolResult { presentation: prior, nested_calls: prior_calls, .. }) = preview.iter().find(|prior| matches!(prior, ToolResult { tool_call_id: id, tool_name: name, .. } if id == tool_call_id && name == tool_name)) {
                *presentation = prior.clone();
                *nested_calls = prior_calls.clone();
            }
        }
    }
    let images: Vec<_> = preview
        .iter()
        .filter(|block| matches!(block, Image { .. }))
        .collect();
    let actual: Vec<_> = content
        .iter_mut()
        .filter(|block| matches!(block, Image { .. }))
        .collect();
    if images.len() != actual.len() {
        return;
    }
    for (preview, block) in images.into_iter().zip(actual) {
        if let (
            Image {
                mime_type: expected,
                content_ref,
                file_id,
                ..
            },
            Image {
                mime_type,
                content_ref: reference,
                file_id: file,
                ..
            },
        ) = (preview, block)
        {
            if mime_type == expected {
                *reference = content_ref.clone();
                *file = file_id.clone();
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::tls::{read_json_line, write_json_line};
    use crate::{
        ConnectionRouter, ContentUpdate, HistoryRecord, IdentityStore, LocalDockEndpoint,
        SessionUpdate,
    };
    use serde_json::{Value, json};
    use std::time::Duration;

    fn cursor(sequence: u64) -> Value {
        json!({"hostEpoch":"epoch","instanceId":"work","runtimeGeneration":1,"sequence":sequence})
    }
    fn target(sequence: u64) -> Value {
        json!({"id":"work","creationOperationId":"create","displayName":"Work","cwd":"/isolated","lifecycle":"active","execution":"idle","compacting":false,"lastRun":"never","reopenable":false,"runtimeGeneration":1,"ownerHostEpoch":"epoch","pending":{"steering":0,"followUp":0,"total":0},"executor":{"kind":"pi","piSessionId":"session"},"toolsExpanded":false,"createdAt":"now","updatedAt":"now","executionChangedAt":"now","eventCursor":cursor(sequence)})
    }
    fn record(n: usize) -> HistoryRecord {
        serde_json::from_value(json!({"recordId":format!("r{n}"),"entryId":format!("h{n}"),"parentId":if n==0 {None} else {Some(format!("h{}",n-1))},"kind":"message","source":"user","visibility":"visible","content":[{"type":"text","text":format!("record-{n}")}]})).unwrap()
    }
    fn read(
        sequence: u64,
        first: usize,
        last: usize,
        truncated: bool,
    ) -> crate::InstanceReadResult {
        serde_json::from_value(json!({"instance":target(sequence),"page":{"events":[],"earliest":cursor(sequence),"latest":cursor(sequence),"truncated":false,"epochChanged":false,"generationChanged":false},"recentHistory":(first..=last).map(record).collect::<Vec<_>>(),"historyRevision":1,"historyTruncated":truncated,"pendingMessages":[]})).unwrap()
    }
    async fn delivered(
        binding: &mut crate::SessionBinding,
        records: usize,
        events: usize,
    ) -> (Vec<String>, usize) {
        let mut ids = Vec::new();
        let mut seen_events = 0;
        while ids.len() < records || seen_events < events {
            for commit in tokio::time::timeout(Duration::from_secs(3), binding.next_batch())
                .await
                .unwrap()
                .unwrap()
            {
                match commit.update {
                    SessionUpdate::Content {
                        update:
                            ContentUpdate::RecordChunk {
                                entry_id,
                                complete: true,
                                ..
                            },
                        ..
                    } => ids.push(entry_id),
                    SessionUpdate::Event(_) | SessionUpdate::ReplayEvent { .. } => seen_events += 1,
                    _ => {}
                }
            }
        }
        (ids, seen_events)
    }
    // Phase-two regression: a new last-200 has no overlap with the old baseline,
    // while 401 accepted raw records are the only copy visible to a rebuilt view.
    #[tokio::test]
    async fn unproven_checkpoint_keeps_raw_tail_and_proven_interval_rebinds_without_duplicates() {
        // Keep the Unix socket below SUN_LEN with an isolated, longer TMPDIR.
        let root = std::env::temp_dir().join(format!(
            "gap-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ));
        std::fs::create_dir(&root).unwrap();
        let socket = root.join("s");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let (reached, waiting) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let mut reached = Some(reached);
            let mut released = Some(released);
            for (anchor, first, last) in [
                ("h202", 152, 201),
                ("h152", 102, 151),
                ("h102", 52, 101),
                ("h52", 2, 51),
                ("h2", 0, 1),
            ] {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = tokio::io::BufReader::new(stream);
                let hello: Value = read_json_line(&mut stream, 1_048_576).await.unwrap();
                write_json_line(&mut stream, &json!({"kind":"hello_ack","catalogSchemaVersion":1,"version":2,"requestId":hello["requestId"],"host":{"hostId":"host","hostEpoch":"epoch","name":"Test","protocolVersion":2},"capabilities":hello["requiredCapabilities"],"limits":{"maxLineBytes":16777216}})).await.unwrap();
                let request: Value = read_json_line(&mut stream, 1_048_576).await.unwrap();
                assert_eq!(request["params"]["beforeEntryId"], anchor);
                if let Some(reached) = reached.take() {
                    reached.send(()).unwrap();
                    released.take().unwrap().await.unwrap();
                }
                write_json_line(&mut stream, &json!({"kind":"response","hostEpoch":"epoch","version":2,"requestId":request["requestId"],"ok":true,"result":{"instance":target(401),"historyRevision":2,"entries":(first..=last).map(record).collect::<Vec<_>>(),"hasEarlier":first!=0,"nextBeforeEntryId":if first==0 {None} else {Some(format!("h{first}"))}}})).await.unwrap();
            }
        });
        let store = IdentityStore::new(root.join("identity"));
        let client = DockClient::new(
            ConnectionRouter::local(
                &store,
                LocalDockEndpoint::configured(socket.to_str().unwrap()).unwrap(),
                "gap-test".into(),
            )
            .unwrap(),
        );
        let content = SessionContent::in_directory(root.join("cache")).unwrap();
        let owner = content.claim("work");
        content
            .commit("work", owner, SessionUpdate::Read(read(0, 0, 0, false)))
            .unwrap();
        for sequence in 1..=401 {
            content.commit("work", owner, SessionUpdate::Event(serde_json::from_value(json!({"instanceId":"work","runtimeGeneration":1,"sequence":sequence,"scope":"instance","occurredAt":"now","type":"message.completed","data":{"messageId":format!("live-{sequence}"),"role":"user","content":[{"type":"text","text":format!("record-{sequence}")}]}})).unwrap())).unwrap();
        }
        content
            .commit(
                "work",
                owner,
                SessionUpdate::Read(read(401, 202, 401, true)),
            )
            .unwrap();
        let service = content.clone();
        let reconcile =
            tokio::spawn(async move { service.reconcile_checkpoint("work", &client).await });
        tokio::time::timeout(Duration::from_secs(3), waiting)
            .await
            .unwrap()
            .unwrap();
        let mut before = content.bind("work").unwrap();
        assert_eq!(
            delivered(&mut before, 1, 401).await,
            (vec!["h0".into()], 401)
        );
        drop(before);
        release.send(()).unwrap();
        reconcile.await.unwrap().unwrap();
        peer.await.unwrap();
        let mut after = content.bind("work").unwrap();
        let (ids, events) = delivered(&mut after, 402, 0).await;
        assert_eq!(ids.len(), 402);
        assert_eq!(ids.first().unwrap(), "h0");
        assert_eq!(ids.last().unwrap(), "h401");
        assert_eq!(events, 0);
        while let Ok(batch) =
            tokio::time::timeout(Duration::from_millis(50), after.next_batch()).await
        {
            assert!(
                batch.unwrap().iter().all(|commit| !matches!(
                    commit.update,
                    SessionUpdate::Event(_) | SessionUpdate::ReplayEvent { .. }
                )),
                "covered raw records cannot reappear after the new seed"
            );
        }
        drop(after);
        drop(content);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn a_proven_branch_replaces_old_content_before_replay_and_keeps_its_new_tail() {
        let root = std::env::temp_dir().join(format!("content-branch-{}", uuid::Uuid::new_v4()));
        let content = SessionContent::in_directory(root.clone()).unwrap();
        let owner = content.claim("work");
        content
            .commit("work", owner, SessionUpdate::Read(read(10, 0, 1, false)))
            .unwrap();
        let old_token = content.content_token("work").unwrap();
        let late = RecordVersion::new(&record(1), true).unwrap();
        let mut display = content.bind("work").unwrap();
        for sequence in 11..=400 {
            content.commit("work", owner, SessionUpdate::Event(serde_json::from_value(json!({"instanceId":"work","runtimeGeneration":1,"sequence":sequence,"scope":"instance","occurredAt":"now","type":"message.completed","data":{"messageId":format!("old-live-{sequence}"),"role":"assistant","content":[{"type":"text","text":"old branch"}]}})).unwrap())).unwrap();
        }
        // Non-truncated current history is itself a complete membership proof,
        // even if a navigation event was missed while the display was detached.
        let mut branch = read(500, 800, 801, false);
        branch.recent_history[0].parent_id = Some("h0".into());
        branch.recent_history.insert(0, record(0));
        content
            .commit("work", owner, SessionUpdate::Read(branch))
            .unwrap();
        content.commit("work", owner, SessionUpdate::Event(serde_json::from_value(json!({"instanceId":"work","runtimeGeneration":1,"sequence":501,"scope":"instance","occurredAt":"now","type":"message.completed","data":{"messageId":"new-live","role":"assistant","content":[{"type":"text","text":"new branch tail"}]}})).unwrap())).unwrap();
        assert!(
            !content.publish_body("work", &old_token, late).unwrap(),
            "an old body cannot publish across the proven branch cut"
        );
        let replacement = display
            .take_replacement()
            .expect("membership replacement uses the existing priority lane");
        assert_ne!(replacement.content_token, old_token);
        let (ids, events) = delivered(&mut display, 3, 1).await;
        assert_eq!(ids, ["h0", "h800", "h801"]);
        assert_eq!(events, 1);
        drop(display);
        drop(content);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn visible_mixed_or_missing_text_still_demands_a_complete_body() {
        // Master-side review: image-only tools carry an empty result identity;
        // a missing later block or any nonempty text must still be readable.
        let descriptor = |content: Value, total_blocks| {
            serde_json::from_value::<crate::ConversationHistoryEntry>(json!({
            "entry": {"recordId":"r","entryId":"e","kind":"message","source":"tool_result","visibility":"visible","content":content},
            "contentRef":"opaque", "contentComplete":false,"totalBlocks":total_blocks
        })).unwrap()
        };
        let image = json!({"type":"image","mimeType":"image/png","contentRef":"opaque-image"});
        let empty = json!({"type":"tool_result","toolCallId":"tool","toolName":"read","text":"","isError":false});
        assert!(!descriptor_needs_body(&descriptor(
            json!([empty, image]),
            2
        )));
        assert!(
            descriptor_needs_body(&descriptor(json!([empty, image]), 3)),
            "missing blocks might contain necessary text"
        );
        assert!(descriptor_needs_body(&descriptor(
            json!([{"type":"text","text":"not provably complete"}, image]),
            2
        )));
        let mut omitted = empty.clone();
        omitted["omittedFields"] = json!(["text"]);
        assert!(descriptor_needs_body(&descriptor(
            json!([omitted, image]),
            2
        )));
    }

    #[test]
    fn completing_text_keeps_image_identity_after_preview_text_blocks_were_removed() {
        use crate::ContentBlock::{Image, Text};
        let preview = vec![Image {
            mime_type: "image/png".into(),
            content_ref: Some("opaque-image".into()),
            data: None,
            file_id: Some("attachment".into()),
        }];
        let mut full = vec![
            Text {
                text: "previously omitted text".into(),
            },
            Image {
                mime_type: "image/png".into(),
                content_ref: None,
                data: Some("original bytes".into()),
                file_id: None,
            },
        ];
        restore_body_metadata(&preview, &mut full);
        assert!(matches!(&full[0], Text { text } if text == "previously omitted text"));
        assert!(
            matches!(&full[1], Image { content_ref: Some(reference), file_id: Some(file), data: Some(data), .. } if reference == "opaque-image" && file == "attachment" && data == "original bytes")
        );
    }
    // Card #350: a long codemode result is read in full, but only the preview lists its calls.
    #[test]
    fn completing_a_long_tool_result_keeps_the_calls_the_tool_made() {
        use crate::ContentBlock::ToolResult;
        let result = |text: &str, nested_calls: Option<serde_json::Value>| ToolResult {
            tool_call_id: "script".into(),
            tool_name: "codemode".into(),
            text: text.into(),
            is_error: false,
            published_file: None,
            presentation: None,
            nested_calls,
            omitted_fields: Vec::new(),
        };
        let calls =
            json!({"calls":[{"toolName":"mcp__harbor__echo","status":"ok"}],"complete":true});
        let preview = vec![result("Script completed", Some(calls.clone()))];
        let mut full = vec![result(
            "Script completed\nOutput:\nharbor echoed lantern",
            None,
        )];
        restore_body_metadata(&preview, &mut full);
        assert!(
            matches!(&full[0], ToolResult { text, nested_calls: Some(restored), .. } if text.ends_with("harbor echoed lantern") && *restored == calls)
        );
    }
    #[tokio::test]
    async fn a_checkpoint_candidate_cannot_discard_an_earlier_page_accepted_during_coverage() {
        let root =
            std::env::temp_dir().join(format!("content-coverage-order-{}", uuid::Uuid::new_v4()));
        let content = SessionContent::in_directory(root.clone()).unwrap();
        let owner = content.claim("work");
        content
            .commit("work", owner, SessionUpdate::Read(read(10, 50, 100, true)))
            .unwrap();
        let token = content.content_token("work").unwrap();
        content
            .commit(
                "work",
                owner,
                SessionUpdate::Read(read(500, 300, 400, true)),
            )
            .unwrap();
        let (_, candidate, _, _) = content.checkpoint_request("work").unwrap();
        let (_, anchor) = content.earlier_request("work", &token).unwrap().unwrap();
        assert_eq!(anchor, "h50");
        let earlier = (0..50)
            .map(|n| RecordVersion::new(&record(n), false).unwrap())
            .collect();
        content
            .finish_earlier("work", &token, &anchor, earlier, false)
            .unwrap();
        let interval = (50..=400)
            .map(|n| RecordVersion::new(&record(n), false).unwrap())
            .collect();
        assert!(
            content
                .finish_checkpoint(
                    "work",
                    &token,
                    candidate.revision,
                    Some("h50"),
                    interval,
                    true
                )
                .unwrap()
                .is_none()
        );
        let mut display = content.bind("work").unwrap();
        let (ids, _) = delivered(&mut display, 101, 0).await;
        assert_eq!(ids.first().unwrap(), "h0");
        assert_eq!(ids.last().unwrap(), "h100");
        assert!(
            content.checkpoint_request("work").is_some(),
            "the reader must re-prove the newer lower boundary, not silently drop it"
        );
        drop(display);
        drop(content);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn body_record_roundtrip_keeps_existing_protocol_metadata_including_explicit_null() {
        for metadata in [json!({"custom":{"value":7}}), Value::Null] {
            let mut wire = serde_json::to_value(record(1)).unwrap();
            wire["metadata"] = metadata.clone();
            wire["metadataOmittedFields"] = json!(["/largeField"]);
            wire["fullOutputPath"] = json!("/remote/opaque-output");
            wire["firstKeptEntryId"] = json!("kept");
            wire["tokensBefore"] = json!(1234);
            wire["fromEntryId"] = json!("from");
            wire["targetEntryId"] = json!("target");
            let decoded: HistoryRecord = serde_json::from_value(wire).unwrap();
            let encoded = serde_json::to_value(decoded).unwrap();
            assert_eq!(encoded["metadata"], metadata);
            assert!(encoded.as_object().unwrap().contains_key("metadata"));
            assert_eq!(encoded["metadataOmittedFields"], json!(["/largeField"]));
            assert_eq!(encoded["fullOutputPath"], "/remote/opaque-output");
            assert_eq!(encoded["firstKeptEntryId"], "kept");
            assert_eq!(encoded["tokensBefore"], 1234);
            assert_eq!(encoded["fromEntryId"], "from");
            assert_eq!(encoded["targetEntryId"], "target");
        }
    }
}
