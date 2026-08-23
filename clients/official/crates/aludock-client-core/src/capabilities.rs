const CORE_V2: &str = "core.v2";
const ATTACHMENTS_V1: &str = "attachments.v1";
const CATALOG_MAINTENANCE_V1: &str = "catalog.maintenance.v1";
const COMMAND_DISCOVERY_V1: &str = "command.discovery.v1";
const COMMAND_IMAGES_PATH_V1: &str = "command.images.path.v1";
const CONVERSATION_CONTENT_V1: &str = "conversation.content.v1";
const CONVERSATION_IMAGES_V1: &str = "conversation.images.v1";
const EVENTS_FOLLOW_V2: &str = "events.follow.v2";
const EXTENSION_UI_CONTROL_V1: &str = "extension_ui.control.v1";
const EXTENSION_UI_PERSISTENT_INTERACTIONS_V1: &str = "extension_ui.persistent-interactions.v1";
const EXTENSION_UI_TOOLS_EXPANDED_V1: &str = "extension_ui.tools-expanded.v1";
const EXTENSION_UI_V1: &str = "extension_ui.v1";
const EXTENSION_UI_WIDGETS_V1: &str = "extension_ui.widgets.v1";
const GIT_BRANCH_FOOTER_V1: &str = "git.branch-footer.v1";
const HOST_INFO_CAPABILITY: &str = "host.info";
const INSTANCE_CATALOG_CAPABILITY: &str = "instance.catalog";
const INSTANCE_DELIVERABLES_V1: &str = "instance.deliverables.v1";
const INSTANCE_DISPLAY_NAME_V1: &str = "instance.display-name.v1";
const INSTANCE_KEYS_V1: &str = "instance.keys.v1";
const INSTANCE_READ_V1: &str = "instance.read.v1";
const MACHINES_V1: &str = "machines.v1";
const MODELS_V1: &str = "models.v1";
const PROJECTION_COMPLETENESS_V1: &str = "projection.completeness.v1";
const PUBLISHED_FILES_V1: &str = "published-files.v1";
const QUEUE_CONTROL_V1: &str = "queue.control.v1";
const RESOURCES_V1: &str = "resources.v1";
const RUN_ABORT_V1: &str = "run.abort.v1";
const SESSION_COMMANDS_V1: &str = "session.commands.v1";
const SESSION_CORE: &str = "session.core";
const SESSION_REOPEN: &str = "session.reopen";
const SESSION_TREE_V2: &str = "session.tree.v2";
const SETTINGS_V1: &str = "settings.v1";
const TOOL_RESULT_PRESENTATION_V1: &str = "tool-result-presentation.v1";
const TOOLS_V1: &str = "tools.v1";
const TUI_PROJECTION_V1: &str = "tui.projection.v1";
const WORKSPACE_FILES_V1: &str = "workspace.files.v1";
const WORKSPACE_LIST_V1: &str = "workspace.list.v1";

macro_rules! snapshot_capabilities {
    ($name:ident $(, $feature:expr)* $(,)?) => {
        pub(crate) const $name: &[&str] = &[
            CORE_V2,
            EXTENSION_UI_TOOLS_EXPANDED_V1,
            GIT_BRANCH_FOOTER_V1,
            INSTANCE_KEYS_V1,
            INSTANCE_DISPLAY_NAME_V1,
            $($feature),*
        ];
    };
}

snapshot_capabilities!(SNAPSHOT);
snapshot_capabilities!(SUBMIT, SESSION_CORE);
snapshot_capabilities!(ABORT, RUN_ABORT_V1);
snapshot_capabilities!(QUEUE, COMMAND_IMAGES_PATH_V1, QUEUE_CONTROL_V1);
snapshot_capabilities!(INSTANCE_CATALOG, INSTANCE_CATALOG_CAPABILITY);
snapshot_capabilities!(INSTANCE_REOPEN, SESSION_REOPEN);
snapshot_capabilities!(MODELS, MODELS_V1, PROJECTION_COMPLETENESS_V1);
snapshot_capabilities!(TOOLS, TOOLS_V1, PROJECTION_COMPLETENESS_V1);
snapshot_capabilities!(SETTINGS, SETTINGS_V1);
snapshot_capabilities!(CONVERSATION_CONTENT, CONVERSATION_CONTENT_V1);
snapshot_capabilities!(CONVERSATION_IMAGES, CONVERSATION_IMAGES_V1);
snapshot_capabilities!(SESSION_HISTORY, TUI_PROJECTION_V1);
snapshot_capabilities!(SESSION_COMMANDS, SESSION_COMMANDS_V1);
snapshot_capabilities!(SESSION_TREE, SESSION_TREE_V2);
snapshot_capabilities!(
    INSTANCE_READ,
    EXTENSION_UI_WIDGETS_V1,
    EXTENSION_UI_PERSISTENT_INTERACTIONS_V1,
    TOOL_RESULT_PRESENTATION_V1,
    INSTANCE_READ_V1,
);
snapshot_capabilities!(
    EVENTS_FOLLOW,
    EXTENSION_UI_WIDGETS_V1,
    EXTENSION_UI_PERSISTENT_INTERACTIONS_V1,
    TOOL_RESULT_PRESENTATION_V1,
    INSTANCE_READ_V1,
    EVENTS_FOLLOW_V2,
);

pub(crate) const HOST_INFO: &[&str] = &[CORE_V2, HOST_INFO_CAPABILITY];
pub(crate) const ATTACHMENTS: &[&str] = &[CORE_V2, ATTACHMENTS_V1];
pub(crate) const INSTANCE_DELIVERABLES: &[&str] = &[CORE_V2, INSTANCE_DELIVERABLES_V1];
pub(crate) const MACHINES: &[&str] = &[CORE_V2, MACHINES_V1];
pub(crate) const PUBLISHED_FILES: &[&str] = &[CORE_V2, PUBLISHED_FILES_V1];
pub(crate) const WORKSPACE_FILES: &[&str] = &[CORE_V2, WORKSPACE_FILES_V1];
pub(crate) const WORKSPACE_LIST: &[&str] = &[CORE_V2, WORKSPACE_LIST_V1];
pub(crate) const CATALOG_MAINTENANCE: &[&str] = &[CORE_V2, CATALOG_MAINTENANCE_V1];
pub(crate) const SESSION_CORE_REQUIRED: &[&str] =
    &[CORE_V2, SESSION_CORE, PROJECTION_COMPLETENESS_V1];
pub(crate) const RESOURCES: &[&str] = &[CORE_V2, RESOURCES_V1, PROJECTION_COMPLETENESS_V1];
pub(crate) const COMMAND_DISCOVERY: &[&str] = &[CORE_V2, COMMAND_DISCOVERY_V1];
pub(crate) const EXTENSION_CONTROL: &[&str] = &[
    CORE_V2,
    EXTENSION_UI_CONTROL_V1,
    EXTENSION_UI_V1,
    EXTENSION_UI_PERSISTENT_INTERACTIONS_V1,
];
pub(crate) const EXTENSION_RESPONSE: &[&str] = &[
    CORE_V2,
    EXTENSION_UI_V1,
    EXTENSION_UI_PERSISTENT_INTERACTIONS_V1,
];
pub(crate) const EXTENSION_WIDGETS: &[&str] = &[CORE_V2, EXTENSION_UI_WIDGETS_V1];

pub(crate) fn submit(has_attachments: bool, has_images: bool) -> Vec<&'static str> {
    let mut capabilities = SUBMIT.to_vec();
    if has_attachments {
        capabilities.push(ATTACHMENTS_V1);
    }
    if has_images {
        capabilities.push(COMMAND_IMAGES_PATH_V1);
    }
    capabilities
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_advertise_the_transitive_capabilities_their_results_require() {
        assert_eq!(
            MODELS,
            [
                "core.v2",
                "extension_ui.tools-expanded.v1",
                "git.branch-footer.v1",
                "instance.keys.v1",
                "instance.display-name.v1",
                "models.v1",
                "projection.completeness.v1",
            ]
        );
        assert_eq!(
            submit(true, true),
            [
                "core.v2",
                "extension_ui.tools-expanded.v1",
                "git.branch-footer.v1",
                "instance.keys.v1",
                "instance.display-name.v1",
                "session.core",
                "attachments.v1",
                "command.images.path.v1",
            ]
        );
    }
}
