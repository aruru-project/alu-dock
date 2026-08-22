import { ControlClientError } from "./control/dock-client.js";

/** Present Dock failures in the user's world; protocol codes and Host diagnostics stay out of human surfaces. */
export function humanControlErrorText(error: ControlClientError): string {
  switch (error.code) {
    case "not_found":
    case "instance_not_found":
      return "This work is no longer in the Dock. Run `aludock` and choose another one.";
    case "instance_host_lost":
      return "The agent for this work disconnected. Run `aludock` to see whether it can be resumed or start new work.";
    case "instance_runtime_error":
      return "The agent for this work stopped unexpectedly. Run `aludock` to see whether it can be resumed or start new work.";
    case "instance_not_active":
      return "This work is not ready for that action. Run `aludock` to check whether it is finishing or can be resumed.";
    case "instance_not_terminal":
      return "This work is still active. Stop it before removing it from Dock history.";
    case "instance_not_reopenable":
      return "There is no saved session for this work. Run `aludock` and start new work instead.";
    case "cursor_stale":
      return "The work list changed while it was loading. Run the command again.";
    case "invalid_cursor":
      return "This view can no longer continue from where it left off. Close and reopen it to reload.";
    case "invalid_tree_target":
      return "That point is no longer in this session. Reopen the tree and choose another point.";
    case "stale_runtime_generation":
      return "This work was reloaded after this window opened. Try the command again.";
    case "admission_pending":
      return "The previous command is still being accepted. Give it a moment, then try again.";
    case "instance_busy":
      return "This work is handling another request. Try again in a moment.";
    case "queue_capacity":
      return "This work already has as many waiting messages as it can hold. Let the current run finish before adding more.";
    case "effect_unknown":
      return "That change may already have happened. Wait for Alu Dock to recover, then refresh before trying again.";
    case "mutation_faulted":
      return "That change stopped before it finished. Check the current work before trying again.";
    case "operation_conflict":
      return "This command conflicts with an earlier submission. Check the conversation before sending anything again.";
    case "operation_receipt_expired":
      return "The result of that earlier command is no longer available. Check the conversation before trying again.";
    case "runtime_unavailable":
      return "The agent is unavailable. Wait a moment; if it does not recover, leave Work and run `aludock` to resume it.";
    case "model_not_found":
      return "That model is not available. Run /model and choose one from the list.";
    case "unknown_tool":
      return "That tool is not available. Run /tools and choose from the tools shown there.";
    case "settings_invalid":
      return "That value is not valid for this setting. Run /settings and choose a supported value.";
    case "invalid_delivery":
      return "That message mode is not available here. Send an ordinary message, or use /steer or /follow.";
    case "compaction_not_needed":
      return "This conversation is already compact enough. You can keep working.";
    case "compaction_cancelled":
      return "Compacting was cancelled. The conversation is ready to continue.";
    case "compaction_failed":
      return "The conversation is still available. You can keep working or try compacting it again.";
    case "interaction_not_found":
    case "interaction_expired":
      return "That question has already closed. The latest result is in the conversation.";
    case "interaction_wrong_lease":
      return "Another window answered this question first.";
    case "interaction_invalid_response":
      return "That answer was not accepted. Try answering again.";
    case "catalog_write_failed":
    case "catalog_corrupt":
      return "Alu Dock could not update its saved work list. Check disk space and service logs, then run `aludock` to review the current work.";
    case "settings_write_failed":
      return "Pi could not save that setting. Check the settings files and try again.";
    case "attachment_not_found":
    case "attachment_integrity":
    case "attachment_unavailable":
      return "That attachment is no longer ready to send. Run /attachments clear, then attach the file again.";
    case "file_unavailable":
      return "That file is no longer available. Ask the agent to publish it again.";
    case "invalid_project_trust_challenge":
      return "That project trust choice expired. Try the action again.";
    case "workspace_changed":
      return "That directory changed while it was loading. Open it again.";
    case "workspace_not_found":
    case "workspace_not_directory":
    case "workspace_permission_denied":
    case "workspace_too_large":
    case "workspace_unavailable":
      return "That directory cannot be opened here. Choose another directory and try again.";
    case "connection_error":
    case "connection_closed":
    case "timeout":
      return "The connection to Alu Dock was interrupted. Wait a moment, then run `aludock` to reopen this work.";
    case "host_starting":
      return "Alu Dock is still starting. Try again in a moment.";
    case "host_draining":
      return "Alu Dock is shutting down. Start it again, then run `aludock` to reopen this work.";
    case "unsupported_protocol":
    case "protocol_incompatible":
    case "capability_missing":
      return "This client and Alu Dock version do not work together. Update the older one and try again.";
    case "request_too_large":
      return "That request is too large to send at once. Make it smaller and try again.";
    default:
      return "That action could not be completed. Try again; if it keeps happening, check `aludock service logs --lines 200`.";
  }
}

export function humanErrorText(error: unknown): string {
  return error instanceof ControlClientError
    ? humanControlErrorText(error)
    : "That action could not be completed. Try again; if it keeps happening, check `aludock service logs --lines 200`.";
}
