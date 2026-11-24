import { readDocument } from "../../platform/documents";

export const SESSION_DOCUMENT = "session.json";
export const OLDER_BUILD_SESSION_DOCUMENT = "session-older-build.json";

export const hasSavedSession = () => !!readDocument(SESSION_DOCUMENT);
