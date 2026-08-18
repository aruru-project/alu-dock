mod actions;
mod attachments;
mod client;
mod config;
mod connections;
mod conversation;
mod endpoint;
mod error;
mod extension_ui;
mod host_registry;
mod identity;
mod instances;
mod pairing;
mod protocol;
mod sessions;
mod srp;
mod storage;
mod tls;

pub use actions::{
    DeliveryMode, QueueDequeueReceipt, QueueDequeueResult, SubmitReceipt, SubmitResult,
};
pub use attachments::{
    AttachmentDto, AttachmentUploadCancellation, AttachmentUploadPhase, AttachmentUploadProgress,
    AttachmentUploadResult, AttachmentUploadStatus,
};
pub use client::DockClient;
pub use config::{
    CommandInfo, CommandsResult, DiagnosticInfo, DiagnosticSeverity, ModelInfo, ModelsResult,
    ResourceInfo, ResourceKind, ResourcesResult, SettingInfo, SettingKey, SettingSource,
    SettingUpdate, SettingUpdateResult, SettingValue, SettingValueType, SettingsResult, SourceInfo,
    SourceKind, ThinkingLevel, ToolInfo, ToolsResult,
};
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
    HostRecord, HostRegistry, HostRegistrySnapshot, PairingTransaction, PromotedPairing,
    VerifiedPairing, validate_host_id,
};
pub use identity::ClientIdentity;
pub use instances::{
    EventCursor, ExecutorSnapshot, ForgetReceipt, ForgetResult, InstanceCatalog, InstanceExecution,
    InstanceLifecycle, InstanceSelector, InstanceSnapshot, ModelIdentity, PendingCounts,
    ProjectTrustDecision, ReopenResult, StopReceipt, StopResult, WorkspaceCursor, WorkspaceEntry,
    WorkspaceEntryKind, WorkspacePage,
};
pub use pairing::{PairingOutcome, PairingProgress, pair};
pub use protocol::{HostIdentity, HostInfo, host_info, host_info_for_profile};
pub use sessions::{
    CompleteConversationPage, ConversationContentChunk, ConversationContentPage,
    ConversationHistoryEntry, ConversationHistoryPage, NavigateOptions, SessionCompaction,
    SessionCompactionResult, SessionForkResult, SessionHistoryPage, SessionInfo, SessionListResult,
    SessionNameResult, SessionNavigateResult, SessionReloadResult, SessionReplacementResult,
    SessionScope, SessionTreePage, TreeDisplayClass, TreeNode, TreeNodeKind, TreeNodeRole,
    TreeNodeState,
};
pub use storage::{IdentityStore, PairingMetadata, PendingPairing, StoredPairing};
