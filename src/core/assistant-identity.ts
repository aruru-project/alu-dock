import type { ClientIdentity } from "@earendil-works/pi-ai";
import { DOCK_VERSION } from "../version.js";

export const ASSISTANT_CLIENT_IDENTITY: ClientIdentity = {
  userAgent: { custom: `AluDock-Assistant/${DOCK_VERSION} (${process.platform}; node/${process.version}; ${process.arch})` },
  attribution: null,
};
