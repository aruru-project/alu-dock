mod actions;
mod attachment_jobs;
mod attachments;
mod capabilities;
mod client;
mod config;
mod connection_router;
mod connections;
mod conversation;
mod conversation_images;
mod deliverables;
mod endpoint;
mod error;
mod extension_ui;
mod file_io;
mod file_transfer;
mod fs_publish;
mod host_registry;
mod identity;
mod instance_records;
mod instances;
pub use instance_records::InstanceDeliveryContext;
mod local_transport;
mod observation;
mod operations;
mod pairing;
mod private_fs;
mod protocol;
mod published_files;
mod run_cache;
mod session_content;
mod session_content_reader;
mod session_journal;
mod session_media;
mod session_records;
mod sessions;
mod srp;
mod storage;
mod systems;
mod timing;
mod tls;
#[cfg(windows)]
mod windows_security;
mod wire;
mod workspace_files;

pub use actions::{
    DeliveryMode, QueueDequeueReceipt, QueueDequeueResult, RestoredImageScope, RestoredImageState,
    SubmitReceipt, SubmitResult,
};
pub use attachment_jobs::{
    AttachmentSnapshot, AttachmentSource, AttachmentState, AttachmentUploadScope, NativeAttachment,
};
pub use attachments::{
    AttachmentDto, AttachmentUploadCancellation, AttachmentUploadPhase, AttachmentUploadProgress,
    AttachmentUploadResult, AttachmentUploadStatus, MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS_PER_MESSAGE,
};
pub use client::DockClient;
pub use config::{
    CommandArgumentCompletion, CommandCompletionItems, CommandCompletionsResult,
    CommandContentResult, CommandInfo, CommandReference, CommandReferenceScope,
    CommandReferenceState, CommandsResult, DiagnosticInfo, DiagnosticSeverity, ModelInfo,
    ModelsResult, ResourceContentResult, ResourceInfo, ResourceKind, ResourcesResult, SettingInfo,
    SettingKey, SettingSource, SettingUpdate, SettingUpdateResult, SettingValue, SettingValueType,
    SettingsResult, SourceInfo, SourceKind, ThinkingLevel, ToolInfo, ToolsResult,
};
pub use connection_router::{ConnectionRouter, RouteSnapshot};
pub use connections::{
    ConnectionKind, ConnectionPolicy, EndpointState, EndpointTestResult, EndpointTestStatus,
    HostConnectionProfile, HostEndpoint, delete_endpoint, host_id, probe_host_endpoint,
    record_endpoint_test, reorder_endpoints, save_unverified_endpoint, save_verified_endpoint,
    saved_endpoint_for_test, set_connection_policy, set_endpoint_enabled,
};
pub use conversation::{
    ContentBlock, DockEvent, EventPage, FollowStream, HistoryRecord, ImagePath, InstanceReadResult,
    PendingMessage, ReadReplay,
};
pub use conversation_images::{ConversationImageTransfer, MAX_CONVERSATION_IMAGE_BYTES};
pub use deliverables::{
    DeliverableDownloadProgress, DeliverableDownloadResult, DeliverableDto,
    MAX_DELIVERABLE_CHUNK_BYTES, MAX_TEMPORARY_DELIVERABLE_BYTES,
    MAX_TEMPORARY_DELIVERABLES_PER_INSTANCE,
};
pub use endpoint::Endpoint;
pub use error::{ClientError, Result};
pub use extension_ui::{
    ActiveInteraction, ControllerEvent, ControllerEventData, EditorDirective, ExtensionBinding,
    ExtensionControlState, ExtensionControlStream, ExtensionControlUpdate, ExtensionController,
    ExtensionControllerLease, ExtensionError, ExtensionEvent, ExtensionNotification,
    InteractionCancellation, InteractionCancellationReason, InteractionMethod, InteractionRequest,
    InteractionResolution, InteractionResolutionState, InteractionRespondResult,
    InteractionResponse, NotificationLevel, StatusChanged, TitleDirective, ToolsExpandedChanged,
    WidgetChanged, WidgetPlacement, WidgetViewportResult,
};
pub use host_registry::{
    ClientPreferences, ClientPreferencesStore, HostRecord, HostRegistry, HostRegistrySnapshot,
    WindowsAwayDelay, validate_host_id,
};
pub use identity::ClientIdentity;
pub use instances::{
    EventCursor, ExecutorSnapshot, ForgetReceipt, ForgetResult, InstanceCatalog, InstanceExecution,
    InstanceLifecycle, InstanceSelector, InstanceSnapshot, Machine, MachineKind, MachinePlatform,
    ModelIdentity, PendingCounts, ProjectTrustDecision, ReopenResult, StopReceipt, StopResult,
    WorkspaceCursor, WorkspaceEntry, WorkspaceEntryKind, WorkspacePage,
};
pub use local_transport::LocalDockEndpoint;
pub use observation::ConversationObservation;
pub use operations::{
    OperationAssociation, OperationAssociations, OperationFailure, OperationState,
};
pub use pairing::{PairingProgress, VerifiedPairing, validate_device_name};
pub use protocol::{HostIdentity, HostInfo, host_info, host_info_for_profile};
pub use published_files::{
    MAX_PUBLISHED_FILE_BYTES, MAX_PUBLISHED_FILE_CHUNK_BYTES, PublishedFileDto,
    PublishedFileTransfer,
};
pub use session_content::{
    ContentUpdate, SessionBinding, SessionCommit, SessionContent, SessionSnapshot, SessionUpdate,
};
pub use session_media::{MAX_ATTACHMENT_PREVIEW_BYTES, MediaHandle, MediaScope};
pub use sessions::{
    CompactionPromptTemplatesResult, ConversationContentChunk, ConversationContentPage,
    ConversationHistoryEntry, ConversationHistoryPage, ConversationReadContext, NavigateOptions,
    SessionChange, SessionCompaction, SessionCompactionResult, SessionForkResult,
    SessionHistoryPage, SessionInfo, SessionInventoryDiagnostic, SessionInventoryResult,
    SessionListResult, SessionNameResult, SessionNavigateResult, SessionReloadResult,
    SessionReplacementResult, SessionScope, SessionTokenScope, SessionTokenState, SessionTree,
    TreeDisplayClass, TreeNode, TreeNodeKind, TreeNodeRole, TreeNodeState,
    begin_session_token_request, publish_session_tokens, resolve_machine_session_token,
    resolve_work_session_token,
};
pub use storage::{IdentityStore, PairingMetadata, StoredPairing};
pub use workspace_files::{
    MAX_WORKSPACE_ENTRY_LIST_ITEMS, MAX_WORKSPACE_FILE_BYTES, MAX_WORKSPACE_FILE_CHUNK_BYTES,
    WorkspaceFileCursor, WorkspaceFileEntry, WorkspaceFileKind, WorkspaceFilePage,
    WorkspaceFileReadProgress, WorkspaceFileReadResult, WorkspaceTargetKind,
    normalize_workspace_path,
};

pub use systems::{
    SystemCandidate, SystemCatalogCursor, SystemCatalogResult, SystemDefaultSetResult,
    SystemSourceKind,
};

pub use actions::{
    SafeQueueDequeueReceipt, SafeQueueDequeueResult, project_queue_dequeue, restored_image_scope,
};
pub use config::{
    SafeCommand, SafeCommandCompletionsResult, SafeCommandContentResult, SafeCommandsResult,
    SafeDiagnostic, SafeResource, SafeResourcesResult, SafeSource, SafeTool, SafeToolsResult,
    project_commands, project_resources, project_source, project_tools,
};
pub use conversation::{
    ConversationBootstrap, ExtensionBootstrap, ProjectedEvent, ProjectedQueueItem,
    project_conversation_read, project_event, project_extension_event, project_pending_message,
    project_session_snapshot, project_session_update, strip_image_paths,
};
pub use extension_ui::safe_controller_event;
pub use operations::operation_association;
pub use sessions::{SafeSessionReload, project_session_reload};

#[cfg(all(test, unix, not(target_os = "android")))]
mod file_read_contract_tests;
