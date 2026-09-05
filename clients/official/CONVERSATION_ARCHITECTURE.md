# Conversation UI ownership

The official client keeps one Protocol V2 conversation state and the existing projection/live reducer path.

- `src/lib/conversationContent.ts` owns the visible conversation content lifecycle: bootstrap publication, historical page loading and incomplete-entry hydration/invalidations, live delta folding, projection scheduling, and streaming markers. It calls `projectConversation` and the existing live helpers; it never reads or writes the DOM.
- `src/lib/conversationViewport.ts` owns follow intent, actual-bottom geometry, row/text anchors, layout observation, and every application-authored conversation scroll write. Content and media owners call `layoutChanged()` rather than scrolling directly. `scrollToBottom()` is the explicit reliable end action.
- `src/components/ConversationView.vue` groups and renders messages and emits interactions. It does not load, project, or scroll content.
- `src/App.vue` composes those owners with connection/follow control, bridge access, image resources, and the rest of the shell.
- `src/conversation.css` is the single stylesheet owner for conversation viewport, rows, process parts, inline conversation images, reading controls, and responsive conversation layout.

Before a live reply becomes completed Markdown, content requests a text-preserving snapshot from the viewport. The viewport uses a native caret/range and the same exact text occurrence within that part; unchanged nodes take the fast path. This work happens at presentation transition, not on every delta. If caret capture or exact matching is unavailable, restoration falls back to the part-level anchor rather than interpreting or rewriting message content. Automatic layout restoration never uses the explicit forced-end action, and a scroll event with no downward movement cannot resume near-bottom following.

Debug content/history from the methods returned by `useConversationContent`; debug reading/follow behavior from the methods returned by `useConversationViewport`. Browser preview uses the real `ConversationView` and viewport controller without a native bridge; temporary validation data can be supplied by a browser driver without adding production hooks.
