import fs from "node:fs/promises";
import path from "node:path";

const SESSION_VERSION = 1;
const MAX_EVENT_QUEUE = 20;

function toSafeFilePart(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url") || "default";
}

export function createDefaultSession(chatKey) {
  const now = Date.now();
  return {
    version: SESSION_VERSION,
    session_id: `sess_${Math.random().toString(36).slice(2, 10)}`,
    chat_key: chatKey,
    created_at: now,
    updated_at: now,
    history: [],
    pending_events: [],
    conversation_state: "normal",
    objective: "",
    active_skill_id: "",
    active_plan: "",
    awaiting_user_input: "none",
    missing_fields: [],
    last_selected_file: "",
    last_result_summary: "",
    last_error: "",
  };
}

export function normalizeSessionShape(raw, chatKey) {
  const base = createDefaultSession(chatKey);
  if (!raw || typeof raw !== "object") return base;

  return {
    ...base,
    ...raw,
    version: SESSION_VERSION,
    chat_key: chatKey,
    history: Array.isArray(raw.history)
      ? raw.history
          .map((row) => ({
            role: row?.role === "assistant" ? "assistant" : "user",
            text: String(row?.text || ""),
            at: Number(row?.at) || Date.now(),
          }))
          .filter((row) => row.text.trim())
      : [],
    pending_events: Array.isArray(raw.pending_events)
      ? raw.pending_events
          .map((evt) => ({
            kind: String(evt?.kind || "info"),
            text: String(evt?.text || "").trim(),
            at: Number(evt?.at) || Date.now(),
          }))
          .filter((evt) => evt.text)
          .slice(-MAX_EVENT_QUEUE)
      : [],
    missing_fields: Array.isArray(raw.missing_fields)
      ? raw.missing_fields.map((v) => String(v || "").trim()).filter(Boolean)
      : [],
  };
}

function resolveSessionPath(stateRoot, chatKey) {
  return path.join(stateRoot, "sessions", `${toSafeFilePart(chatKey)}.json`);
}

export async function loadSession(stateRoot, chatKey) {
  const filePath = resolveSessionPath(stateRoot, chatKey);
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    return normalizeSessionShape(raw, chatKey);
  } catch {
    return createDefaultSession(chatKey);
  }
}

export async function saveSession(stateRoot, session) {
  const chatKey = String(session?.chat_key || "chat:default");
  const normalized = normalizeSessionShape(session, chatKey);
  normalized.updated_at = Date.now();

  const sessionsDir = path.join(stateRoot, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const filePath = resolveSessionPath(stateRoot, chatKey);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(normalized, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
  return normalized;
}

export function appendSessionHistory(session, role, text, maxHistory = 40) {
  const next = normalizeSessionShape(session, session?.chat_key || "chat:default");
  const trimmed = String(text || "").trim();
  if (!trimmed) return next;
  next.history.push({ role: role === "assistant" ? "assistant" : "user", text: trimmed, at: Date.now() });
  if (next.history.length > maxHistory) {
    next.history = next.history.slice(-maxHistory);
  }
  return next;
}

export function getRecentHistory(session, maxHistory = 10) {
  const rows = Array.isArray(session?.history) ? session.history : [];
  return rows.slice(-maxHistory).map((row) => ({ role: row.role, text: row.text, at: row.at }));
}

export function enqueueSessionEvent(session, text, kind = "info") {
  const next = normalizeSessionShape(session, session?.chat_key || "chat:default");
  const cleaned = String(text || "").trim();
  if (!cleaned) return next;
  next.pending_events.push({ kind: String(kind || "info"), text: cleaned, at: Date.now() });
  if (next.pending_events.length > MAX_EVENT_QUEUE) {
    next.pending_events = next.pending_events.slice(-MAX_EVENT_QUEUE);
  }
  return next;
}

export function drainSessionEvents(session) {
  const next = normalizeSessionShape(session, session?.chat_key || "chat:default");
  const events = Array.isArray(next.pending_events) ? next.pending_events.slice() : [];
  next.pending_events = [];
  return { session: next, events };
}

export function applySessionStatePatch(session, patch) {
  const next = normalizeSessionShape(session, session?.chat_key || "chat:default");
  if (!patch || typeof patch !== "object") return next;

  if (typeof patch.objective === "string") next.objective = patch.objective.trim();
  if (typeof patch.active_skill_id === "string") next.active_skill_id = patch.active_skill_id.trim();
  if (typeof patch.active_plan === "string") next.active_plan = patch.active_plan.trim();
  if (typeof patch.awaiting_user_input === "string") {
    const value = patch.awaiting_user_input.trim().toLowerCase();
    if (["none", "confirmation", "missing_param"].includes(value)) next.awaiting_user_input = value;
  }
  if (Array.isArray(patch.missing_fields)) {
    next.missing_fields = patch.missing_fields.map((v) => String(v || "").trim()).filter(Boolean);
  }
  if (typeof patch.last_selected_file === "string") next.last_selected_file = patch.last_selected_file.trim();
  if (typeof patch.last_result_summary === "string") next.last_result_summary = patch.last_result_summary.trim();
  if (typeof patch.last_error === "string") next.last_error = patch.last_error.trim();
  if (typeof patch.conversation_state === "string") {
    const value = patch.conversation_state.trim().toLowerCase();
    if (["normal", "awaiting_confirmation", "awaiting_missing_param", "executing"].includes(value)) {
      next.conversation_state = value;
    }
  }

  return next;
}

export function buildSessionPromptState(session) {
  const s = normalizeSessionShape(session, session?.chat_key || "chat:default");
  return {
    conversation_state: s.conversation_state,
    objective: s.objective,
    active_skill_id: s.active_skill_id,
    active_plan: s.active_plan,
    awaiting_user_input: s.awaiting_user_input,
    missing_fields: s.missing_fields,
    last_selected_file: s.last_selected_file,
    last_result_summary: s.last_result_summary,
    last_error: s.last_error,
  };
}
