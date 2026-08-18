# AluDock Client → Dock requirements

These are client product requirements that cannot be implemented safely by inventing client-side behavior. The Dock repository remains read-only from this project.

## Work stop is supported

The graphical client exposes Protocol V2 `instance.stop` as a distinct, confirmed Work lifecycle action. Its confirmation states the authoritative Dock semantics: it stops the shared Work and current run and clears every accepted Queue item, including items admitted by another client. The client validates the correlated stopped snapshot, reports receipt cleanup errors, preserves its local draft, and reconciles rather than replaying an effect-unknown stop. No additional Dock contract is required for Stop.

This is intentionally separate from Queue restore. A user choosing Stop explicitly accepts Queue clearing; the action does not claim to preserve or dequeue queued messages.

## Queue dequeue with attachments and in-flight state is supported

“取回排队消息” now calls Dock's atomic `queue.dequeue` and trusts its correlated receipt. The client appends only `restored` text and canonical attachment DTOs to the latest Composer state, retains restored image descriptors only inside the native process, and never infers attachment identity from digest, name, or `stored | reused`. `inFlight` remains informational and is never placed into an editable or resubmittable draft.

There is intentionally no invented Queue revision or Host-path exposure. An effect-unknown dequeue stops the action and asks for reconciliation rather than claiming success. Native restored image references and uploads in progress are process-local C-client state; successfully uploaded unsent attachment DTOs are the only attachment draft data persisted by Host/Work. Whole-Work Stop remains a separate confirmed action that intentionally clears Queue.

## Optional LAN discovery

Moonlight-style automatic LAN discovery requires a documented Dock service advertisement contract (for example mDNS/DNS-SD service type, instance/TXT fields, versioning, and lifecycle). No such contract currently exists, so the client uses manual address + port entry and automatic fallback among already verified addresses. Discovery candidates must never bypass pairing or exact Host certificate verification.
