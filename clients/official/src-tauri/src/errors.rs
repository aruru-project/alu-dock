use aludock_client_core::{ClientError, MAX_ATTACHMENT_BYTES};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) details: Option<Value>,
    pub(crate) outcome_unknown: bool,
    pub(crate) operation_id: Option<String>,
}

impl aludock_client_core::OperationFailure for CommandError {
    fn outcome_unknown(&self) -> bool {
        self.outcome_unknown
    }
    fn presentation(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

impl From<ClientError> for CommandError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::Action { code, message } => Self {
                code: code.into(),
                message: message.into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::InvalidEndpoint(message) => Self {
                code: "invalid_endpoint".into(),
                message,
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::InvalidPairing(message) => {
                let (code, message) = if message.contains("timed out waiting") {
                    (
                        "pairing_timeout",
                        "等待电脑确认超时。请重新打开配对窗口后再试。",
                    )
                } else if message.contains("pending state was kept")
                    || message.contains("pairing finalization is pending")
                {
                    (
                        "finalization_pending",
                        "电脑可能已经接受配对，但最终连接尚未确认。请保持地址不变并再次尝试，客户端会安全恢复。",
                    )
                } else {
                    (
                        "pairing_invalid",
                        "配对状态无法继续。请确认电脑端配对窗口仍然打开，然后重试。",
                    )
                };
                Self {
                    code: code.into(),
                    message: message.into(),
                    details: None,
                    outcome_unknown: false,
                    operation_id: None,
                }
            }
            ClientError::PairingRejected { code, .. } => {
                let message = match code.as_str() {
                    "pairing_closed" => {
                        "电脑端配对窗口未打开或已经关闭。请在 AluDock 中重新打开五分钟配对窗口。"
                    }
                    "busy" => "电脑正在处理另一台设备的配对，请稍后再试。",
                    "wrong_pin" => "电脑端输入的配对码不正确。本次请求已结束，请重新开始。",
                    "expired" | "not_found" => {
                        "这次配对请求已经过期。请重新打开配对窗口并再次开始。"
                    }
                    "invalid_request" => "电脑无法识别这次配对请求，请检查客户端和 Dock 版本。",
                    _ => "电脑端没有完成配对，请查看 AluDock 的配对状态后重试。",
                };
                Self {
                    code,
                    message: message.into(),
                    details: None,
                    outcome_unknown: false,
                    operation_id: None,
                }
            }
            ClientError::HostCertificateMismatch => Self {
                code: "host_certificate_mismatch".into(),
                message: "这个地址不是当前配对的 AluDock，未保存任何更改。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Host {
                code,
                message,
                details,
                ..
            } => Self {
                code,
                message,
                details,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::EffectUnknown {
                operation_id,
                message,
            } => Self {
                code: "effect_unknown".into(),
                message,
                details: None,
                outcome_unknown: true,
                operation_id: Some(operation_id),
            },
            ClientError::AttachmentTooLarge {
                size_bytes,
                maximum_bytes,
            } => Self {
                code: "attachment_too_large".into(),
                message: msg_attachment_too_large(),
                details: Some(serde_json::json!({
                    "sizeBytes": size_bytes,
                    "maximumBytes": maximum_bytes,
                })),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::AttachmentSourceChanged => Self {
                code: "attachment_source_changed".into(),
                message: "附件源文件在上传期间发生了变化，请重新选择。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::AttachmentUploadCancelled => Self {
                code: "attachment_upload_cancelled".into(),
                message: "附件上传已取消。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Tls(_) | ClientError::MissingHostCertificate => Self {
                code: "connection_failed".into(),
                message: "无法建立安全连接。请检查地址、端口、防火墙和电脑端 AluDock 状态。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::RegistryConflict { expected, actual } => Self {
                code: "registry_conflict".into(),
                message: "Host 列表已在其他操作中更新，请刷新后重试。".into(),
                details: Some(
                    serde_json::json!({ "expectedRevision": expected, "actualRevision": actual }),
                ),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::PreferencesConflict { expected, actual } => Self {
                code: "preferences_conflict".into(),
                message: "设置已在其他窗口中更新，请重新选择。".into(),
                details: Some(
                    serde_json::json!({ "expectedRevision": expected, "actualRevision": actual }),
                ),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::ProfileConflict { expected, actual } => Self {
                code: "profile_conflict".into(),
                message: "连接地址已在其他操作中更新，请刷新后重试。".into(),
                details: Some(
                    serde_json::json!({ "expectedRevision": expected, "actualRevision": actual }),
                ),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::HostNotFound(host_id) => Self {
                code: "host_not_found".into(),
                message: "这台 Host 已不在此设备的 Host 列表中。".into(),
                details: Some(serde_json::json!({ "hostId": host_id })),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::HostAlreadySaved(host_id) => Self {
                code: "host_already_saved".into(),
                message: "这台 Host 已保存在此设备上，可以直接使用。".into(),
                details: Some(serde_json::json!({ "hostId": host_id })),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Storage { .. } | ClientError::Io(_) => Self {
                code: "local_storage_unavailable".into(),
                message: "无法读取或保存这台设备上的数据。请检查应用存储权限和可用空间。".into(),
                details: None,
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Protocol(reason) => Self {
                code: "protocol_error".into(),
                message: "收到的数据无法识别。请刷新当前内容后重试。".into(),
                details: Some(serde_json::json!({ "reason": reason })),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Json(error) => Self {
                code: "client_error".into(),
                message: "客户端无法完成数据处理。请刷新当前内容后重试。".into(),
                details: Some(serde_json::json!({ "reason": error.to_string() })),
                outcome_unknown: false,
                operation_id: None,
            },
            ClientError::Crypto(reason) => Self {
                code: "client_error".into(),
                message: "客户端无法完成数据处理。请刷新当前内容后重试。".into(),
                details: Some(serde_json::json!({ "reason": reason })),
                outcome_unknown: false,
                operation_id: None,
            },
        }
    }
}

pub(crate) fn lifecycle_error() -> CommandError {
    CommandError {
        code: "host_lifecycle_unavailable".into(),
        message: "暂时无法切换 Host。请稍后重试。".into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

pub(crate) fn image_error(code: &str, message: &str) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
        details: None,
        outcome_unknown: false,
        operation_id: None,
    }
}

pub(crate) fn msg_attachment_too_large() -> String {
    format!(
        "附件超过 {} MiB 大小限制。",
        MAX_ATTACHMENT_BYTES / 1024 / 1024
    )
}
