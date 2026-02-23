import { drainSessionEvents, enqueueSessionEvent } from "./session-store.mjs";

export function pushEvent(session, text, kind = "info") {
  return enqueueSessionEvent(session, text, kind);
}

export function consumeEvents(session) {
  return drainSessionEvents(session);
}
