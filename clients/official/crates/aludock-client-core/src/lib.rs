mod actions;
mod attachments;
mod attachment_jobs;
mod capabilities;
mod client;
mod config;
mod connection_router;
mod connections;
mod conversation;
mod deliverables;
mod endpoint;
mod error;
mod extension_ui;
mod fs_publish;
mod host_registry;
mod identity;
mod instances;
mod local_transport;
mod observation;
mod operations;
mod pairing;
mod private_fs;
mod protocol;
mod published_files;
mod sessions;
mod session_content;
mod session_records;
mod session_content_reader;
mod session_journal;
mod session_media;
mod run_cache;
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
    DeliveryMode, QueueDequeueReceipt, QueueDequeueResult, SubmitReceipt, SubmitResult,
};
pub use attachment_jobs::{AttachmentSource, AttachmentState, NativeAttachment, AttachmentUploadScope, AttachmentSnapshot};
pub use attachments::{
    AttachmentDto, AttachmentUploadCancellation, AttachmentUploadPhase, AttachmentUploadProgress,
    AttachmentUploadResult, AttachmentUploadStatus, MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS_PER_MESSAGE,
};
pub use client::DockClient;
pub use config::{
    CommandArgumentCompletion, CommandCompletionItems, CommandCompletionsResult,
    CommandContentResult, CommandInfo, CommandReference, CommandsResult, DiagnosticInfo,
    DiagnosticSeverity, ModelInfo, ModelsResult, ResourceContentResult, ResourceInfo, ResourceKind,
    ResourcesResult, SettingInfo, SettingKey, SettingSource, SettingUpdate, SettingUpdateResult,
    SettingValue, SettingValueType, SettingsResult, SourceInfo, SourceKind, ThinkingLevel,
    ToolInfo, ToolsResult,
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
pub use deliverables::{
    DeliverableDownloadProgress, DeliverableDownloadResult, DeliverableDto,
    MAX_DELIVERABLE_CHUNK_BYTES, MAX_TEMPORARY_DELIVERABLE_BYTES,
    MAX_TEMPORARY_DELIVERABLES_PER_INSTANCE,
};
pub use endpoint::Endpoint;
pub use error::{ClientError, Result};
pub use extension_ui::{
    ActiveInteraction, ControllerEvent, ControllerEventData, EditorDirective,
    ExtensionControlStream, ExtensionController, ExtensionControllerLease, ExtensionError,
    ExtensionEvent, ExtensionNotification, InteractionCancellation, InteractionCancellationReason,
    InteractionMethod, InteractionRequest, InteractionResolution, InteractionResolutionState,
    InteractionRespondResult, InteractionResponse, NotificationLevel, StatusChanged,
    TitleDirective, ToolsExpandedChanged, WidgetChanged, WidgetPlacement, WidgetViewportResult,
};
pub use host_registry::{
    ClientPreferences, ClientPreferencesStore, HostRecord, HostRegistry, HostRegistrySnapshot,
    PairingTransaction, PromotedPairing, VerifiedPairing, WindowsAwayDelay, validate_host_id,
};
pub use identity::ClientIdentity;
pub use instances::{
    EventCursor, ExecutorSnapshot, ForgetReceipt, ForgetResult, InstanceCatalog, InstanceExecution,
    InstanceLifecycle, InstanceSelector, InstanceSnapshot, Machine, MachineKind, MachinePlatform,
    ModelIdentity, PendingCounts, ProjectTrustDecision, ReopenResult, StopReceipt, StopResult,
    WorkspaceCursor, WorkspaceEntry, WorkspaceEntryKind, WorkspacePage,
};
pub use local_transport::LocalDockEndpoint;
pub use operations::{OperationAssociation, OperationAssociations};
pub use observation::ConversationObservation;
pub use session_media::{MediaHandle, MediaScope, MAX_ATTACHMENT_PREVIEW_BYTES};
pub use session_content::{SessionContent, SessionSnapshot, SessionCommit, SessionUpdate, SessionBinding, ContentUpdate};
pub use pairing::{PairingOutcome, PairingProgress, pair, validate_device_name};
pub use protocol::{HostIdentity, HostInfo, host_info, host_info_for_profile};
pub use published_files::{
    MAX_PUBLISHED_FILE_BYTES, MAX_PUBLISHED_FILE_CHUNK_BYTES, PublishedFileTransfer, PublishedFileDto,
};
pub use sessions::{
    CompactionPromptTemplatesResult, ConversationContentChunk,
    ConversationContentPage, ConversationHistoryEntry, ConversationHistoryPage,
    ConversationImageTransfer, MAX_CONVERSATION_IMAGE_BYTES, NavigateOptions,
    SessionCompaction, SessionCompactionResult, SessionForkResult, SessionHistoryPage, SessionInfo,
    SessionInventoryDiagnostic, SessionInventoryResult, SessionListResult, SessionNameResult,
    SessionNavigateResult, SessionReloadResult, SessionReplacementResult, SessionScope,
    SessionTree, TreeDisplayClass, TreeNode, TreeNodeKind, TreeNodeRole, TreeNodeState,
};
pub use storage::{IdentityStore, PairingMetadata, PendingPairing, StoredPairing};
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
