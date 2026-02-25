import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import {
  executeSkill,
  getSkillContext,
  loadSkillsRuntime,
  summarizeSkill,
} from "./skills-runtime.mjs";
import {
  appendSessionHistory,
  applySessionStatePatch,
  buildSessionPromptState,
  createDefaultSession,
  getRecentHistory,
  loadSession,
  saveSession,
} from "./session-store.mjs";
import { consumeEvents, pushEvent } from "./session-events.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

let _debug = () => {};

const DEFAULT_AGENT_NAME = "Fruit Bowl Agent";
const DEFAULT_AGENT_ROLE =
  "You are a service-minded assistant. You can answer general questions and use enabled local skills when they provide better results.";

const MAX_CHAT_HISTORY = 10;
const MAX_SESSION_HISTORY = 40;

function parseDotEnv(content) {
  const map = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

async function loadEnvFile() {
  const envPath = path.join(projectRoot, ".env");
  try {
    return parseDotEnv(await fs.readFile(envPath, "utf8"));
  } catch {
    return new Map();
  }
}

function envValue(key, fileMap, fallback = "") {
  if (process.env[key] !== undefined) return process.env[key];
  if (fileMap.has(key)) return fileMap.get(key);
  return fallback;
}

async function readUtf8IfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function listFilesRecursive(rootDir, maxFiles = 250) {
  const out = [];
  async function walk(dir) {
    if (out.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(rootDir);
  return out;
}

async function buildMemorySnapshot(memoryRoot, maxFiles = 120) {
  const files = await listFilesRecursive(memoryRoot, maxFiles);
  const snapshot = files.map((f) => {
    const rel = path.relative(memoryRoot, f).split(path.sep).join("/");
    const top = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "(root)";
    return { path: rel, category: top };
  });
  const byCategory = {};
  for (const row of snapshot) {
    byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
  }
  return { files: snapshot, byCategory };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 1_000_000) {
        reject(new Error("request too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function fetchJsonWithTimeout(url, init, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function uniqueModels(models) {
  const out = [];
  const seen = new Set();
  for (const m of models) {
    const key = String(m || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function buildModelCandidates(primaryModel) {
  return uniqueModels([primaryModel, "gpt-4.1"]);
}

async function callResponsesApi({
  apiKey,
  model,
  input,
  maxOutputTokens = 700,
  timeoutMs = 45_000,
  temperature,
}) {
  const candidates = buildModelCandidates(model);
  const errors = [];

  for (const candidate of candidates) {
    _debug(`openai call [${candidate}]`, `max_tokens=${maxOutputTokens}`);
    const body = {
      model: candidate,
      input,
      max_output_tokens: maxOutputTokens,
    };
    const supportsTemperature = !candidate.includes("codex");
    if (typeof temperature === "number" && supportsTemperature) body.temperature = temperature;
    const resp = await fetchJsonWithTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );

    if (resp.ok) {
      const data = await resp.json();
      const text = extractResponseText(data);
      _debug(
        `openai response [${candidate}]`,
        text
          ? text.slice(0, 300)
          : `(empty) keys=${Object.keys(data || {}).join(",")}`,
      );
      if (text) {
        return { data, modelUsed: candidate };
      }
      // Model returned 200 but no extractable text — try next candidate
      errors.push(`${candidate}: 200 but empty response text`);
      continue;
    }

    const txt = await resp.text();
    errors.push(`${candidate}: ${resp.status} ${txt}`);
    _debug(
      `openai error [${candidate}]`,
      `${resp.status} ${txt.slice(0, 300)}`,
    );
  }

  throw new Error(
    `OpenAI responses call failed for all models. ${errors.join(" | ")}`,
  );
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const output = Array.isArray(data?.output) ? data.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === "string" && block.text.trim()) {
        parts.push(block.text.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("model returned no json object");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function getChatKey(body) {
  if (typeof body.chatId === "number" && Number.isFinite(body.chatId))
    return `chat:${body.chatId}`;
  if (typeof body.chatId === "string" && body.chatId.trim())
    return `chat:${body.chatId.trim()}`;
  return "chat:default";
}

function buildExecutionResultSnippet(
  executionResult,
  maxLines = 14,
  maxChars = 2600,
) {
  const raw =
    typeof executionResult?.result === "string" && executionResult.result.trim()
      ? executionResult.result.trim()
      : JSON.stringify(executionResult, null, 2);
  const lines = raw.split("\n").slice(0, maxLines);
  const text = lines.join("\n");
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n...[truncated]`
    : text;
}

function ensureReplyContainsResult(reply, _resultSnippet) {
  // Trust the LLM's composed reply — the system prompt instructs it to
  // include key values inline.  Appending raw JSON/dict snippets produces
  // ugly output in Telegram, so we no longer do that.
  return reply;
}

function summarizeExecutionResult(executionResult, maxChars = 280) {
  const snippet = buildExecutionResultSnippet(executionResult, 4, maxChars);
  return snippet.replace(/\s+/g, " ").trim();
}

function buildReferenceMemory(sessionState) {
  const state =
    sessionState && typeof sessionState === "object" ? sessionState : {};
  return {
    objective: String(state.objective || ""),
    active_skill_id: String(state.active_skill_id || ""),
    awaiting_user_input: String(state.awaiting_user_input || "none"),
    missing_fields: Array.isArray(state.missing_fields)
      ? state.missing_fields
      : [],
    last_selected_file: String(state.last_selected_file || ""),
    last_result_summary: String(state.last_result_summary || ""),
  };
}

function summarizeSkillContext(raw) {
  if (!raw || typeof raw !== "object") return { ok: false };
  if (Array.isArray(raw.catalog)) {
    return {
      ok: raw.ok !== false,
      type: "catalog",
      files: raw.catalog.slice(0, 20).map((item) => ({
        file: item.file,
        rows: item.rows,
        columns: Array.isArray(item.columns) ? item.columns.slice(0, 12) : [],
        error: item.error,
      })),
      file_count: raw.catalog.length,
    };
  }
  return {
    ok: raw.ok !== false,
    keys: Object.keys(raw).slice(0, 20),
  };
}

function normalizeRouterDecision(raw) {
  const modeRaw =
    typeof raw?.mode === "string" ? raw.mode.trim().toLowerCase() : "chat";
  const mode = ["chat", "skill", "clarify"].includes(modeRaw)
    ? modeRaw
    : "chat";
  const skillId = typeof raw?.skill_id === "string" ? raw.skill_id.trim() : "";
  const action =
    raw?.action && typeof raw.action === "object" ? raw.action : {};
  const assistantReply =
    typeof raw?.assistant_reply === "string" && raw.assistant_reply.trim()
      ? raw.assistant_reply.trim()
      : "";
  const clarifyingQuestion =
    typeof raw?.clarifying_question === "string" &&
    raw.clarifying_question.trim()
      ? raw.clarifying_question.trim()
      : "";
  const conversationStateRaw =
    typeof raw?.conversation_state === "string"
      ? raw.conversation_state.trim().toLowerCase()
      : "";
  const conversationState = [
    "normal",
    "awaiting_confirmation",
    "awaiting_missing_param",
    "executing",
  ].includes(conversationStateRaw)
    ? conversationStateRaw
    : "";
  const missingFields = Array.isArray(raw?.missing_fields)
    ? raw.missing_fields.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  const resolvedReferences =
    raw?.resolved_references && typeof raw.resolved_references === "object"
      ? raw.resolved_references
      : {};
  const stateUpdates =
    raw?.state_updates && typeof raw.state_updates === "object"
      ? raw.state_updates
      : {};
  return {
    mode,
    skill_id: skillId,
    action,
    assistant_reply: assistantReply,
    clarifying_question: clarifyingQuestion,
    conversation_state: conversationState,
    missing_fields: missingFields,
    resolved_references: resolvedReferences,
    state_updates: stateUpdates,
  };
}

function skillSupportsOperation(skill, op) {
  return Array.isArray(skill?.operations) && skill.operations.includes(op);
}

function extractCatalogForSkill(skillContexts, skillId) {
  const ctx = skillContexts.get(skillId);
  if (!ctx || typeof ctx !== "object" || !Array.isArray(ctx.catalog)) return [];
  return ctx.catalog.slice(0, 40).map((item) => ({
    file: item.file,
    rows: item.rows,
    columns: Array.isArray(item.columns) ? item.columns.slice(0, 30) : [],
    error: item.error,
  }));
}

function pickLikelyFileFromCatalog(catalog, message, history) {
  if (!Array.isArray(catalog) || catalog.length === 0) return "";
  const haystack = `${message}\n${JSON.stringify(history || [])}`.toLowerCase();
  let best = { file: catalog[0].file || "", score: -1 };
  for (const item of catalog) {
    const file = String(item?.file || "");
    if (!file) continue;
    let score = 0;
    const fileLower = file.toLowerCase();
    if (haystack.includes(fileLower)) score += 10;
    const stem = fileLower.replace(/\.[a-z0-9]+$/i, "");
    for (const token of stem.split(/[^a-z0-9æøå]+/i)) {
      if (token && token.length > 2 && haystack.includes(token)) score += 2;
    }
    const cols = Array.isArray(item?.columns)
      ? item.columns.map((c) => String(c).toLowerCase())
      : [];
    if (cols.includes("beløb") || cols.includes("belob")) score += 3;
    if (
      cols.includes("dato") ||
      cols.includes("date") ||
      cols.includes("event_date")
    )
      score += 2;
    if (score > best.score) best = { file, score };
  }
  return best.file;
}

function buildHeuristicPythonPlan({ message, history, catalog }) {
  const text = String(message || "").toLowerCase();
  const file = pickLikelyFileFromCatalog(catalog, message, history);

  const asksTopByDate =
    /(hvilke|which|what).*(dage|dato|dates?).*(største|højeste|largest|highest|top)/i.test(
      text,
    ) || /største.*(værdi|value|beløb|amount)/i.test(text);
  if (asksTopByDate) {
    return normalizePythonPlan({
      file: file || undefined,
      explanation: "Jeg finder datoer med de højeste summerede værdier.",
      limit: 20,
      code: [
        "source = df.copy() if 'df' in locals() else read_table(discover_files()[0])",
        "date_candidates = [c for c in source.columns if str(c).lower() in ['dato','date','event_date']]",
        "date_col = date_candidates[0] if date_candidates else source.columns[0]",
        "value_candidates = [c for c in source.columns if str(c).lower() in ['beløb','belob','amount','value','total_sales']]",
        "val_col = value_candidates[0] if value_candidates else None",
        "if val_col is None:",
        "    numeric_cols = list(source.select_dtypes(include='number').columns)",
        "    val_col = numeric_cols[0] if numeric_cols else source.columns[-1]",
        "tmp = source.copy()",
        "series = tmp[val_col]",
        "if series.dtype == 'object':",
        "    series = series.astype(str).str.replace('.', '', regex=False).str.replace(',', '.', regex=False)",
        "tmp['_val'] = pd.to_numeric(series, errors='coerce').fillna(0)",
        "result = tmp.groupby(date_col, dropna=False)['_val'].sum().reset_index().sort_values('_val', ascending=False).head(10)",
      ].join("\n"),
    });
  }

  const asksDates =
    /(hvilke|which|what).*(dage|dato|dates?).*(med|er|finnes|findes)?/i.test(
      text,
    ) || /dates?.*(dataset|data)/i.test(text);
  if (asksDates) {
    return normalizePythonPlan({
      file: file || undefined,
      explanation: "Jeg udtrækker unikke datoer i datasættet.",
      limit: 200,
      code: [
        "source = df.copy() if 'df' in locals() else read_table(discover_files()[0])",
        "date_candidates = [c for c in source.columns if str(c).lower() in ['dato','date','event_date']]",
        "date_col = date_candidates[0] if date_candidates else source.columns[0]",
        "dates = sorted([str(x) for x in source[date_col].dropna().astype(str).unique()])",
        "result = {'date_column': str(date_col), 'count': len(dates), 'dates': dates}",
      ].join("\n"),
    });
  }

  return normalizePythonPlan({
    file: file || undefined,
    explanation:
      "Jeg starter med et preview for at fastlægge den rette analyse.",
    limit: 20,
    code: "source = df.copy() if 'df' in locals() else read_table(discover_files()[0])\nresult = source.head(20)",
  });
}

function normalizePythonPlan(raw) {
  const file =
    typeof raw?.file === "string" && raw.file.trim()
      ? raw.file.trim()
      : undefined;
  const code = typeof raw?.code === "string" ? raw.code.trim() : "";
  const explanation =
    typeof raw?.explanation === "string" && raw.explanation.trim()
      ? raw.explanation.trim()
      : "Jeg laver en målrettet pandas-analyse.";
  const limitRaw = Number(raw?.limit);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(5, Math.min(200, Math.floor(limitRaw)))
    : 50;
  return { file, code, explanation, limit };
}

async function planPythonCodeWithModel({
  apiKey,
  model,
  message,
  history,
  skill,
  catalog,
  previousAttempts,
}) {
  if (!apiKey) {
    return normalizePythonPlan({
      code: "result = df.head(10) if 'df' in locals() else read_table(discover_files()[0]).head(10)",
      explanation:
        "Jeg starter med et sikkert preview, da OpenAI ikke er konfigureret.",
      limit: 20,
    });
  }

  const systemPrompt = [
    "You generate Python pandas code for a local skill executor.",
    "Return ONLY JSON with keys: file?, code, explanation, limit?.",
    "Rules:",
    "- Use helpers: discover_files(), read_table(rel_path), write_table(df, rel_path), pd, optional df.",
    "- Always assign the final answer object to variable `result`.",
    "- Keep code deterministic and safe.",
    "- If you need a specific file, set file to one from catalog.",
    "- On retries, fix previous errors and refine logic.",
  ].join(" ");

  const userPrompt = [
    `User request: ${message}`,
    "",
    "Recent history:",
    JSON.stringify(history),
    "",
    "Skill summary:",
    JSON.stringify(summarizeSkill(skill)),
    "",
    "Catalog:",
    JSON.stringify(catalog),
    "",
    "Previous code attempts (latest first):",
    JSON.stringify(previousAttempts.slice(-3)),
    "",
    "Return JSON only.",
  ].join("\n");

  const { data } = await callResponsesApi({
    apiKey,
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    maxOutputTokens: 1500,
    timeoutMs: 45_000,
    temperature: 0.2,
  });
  const text = extractResponseText(data);
  if (!text) throw new Error("OpenAI python-plan returned empty output");
  return normalizePythonPlan(extractJsonObject(text));
}

async function evaluatePythonResultWithModel({
  apiKey,
  model,
  message,
  plan,
  executionResult,
}) {
  if (!apiKey) return { satisfied: true, reason: "no_api_key" };
  const resultSnippet = buildExecutionResultSnippet(executionResult, 18, 2600);

  const systemPrompt = [
    "Evaluate whether the executed pandas result answers the user request.",
    "Return ONLY JSON: {satisfied:boolean, reason:string, next_instruction?:string}.",
    "Set satisfied=false if result is missing required aggregation/filter/detail.",
  ].join(" ");

  const userPrompt = [
    `User request: ${message}`,
    "",
    "Plan used:",
    JSON.stringify(plan),
    "",
    "Execution result snippet:",
    resultSnippet,
    "",
    "Return JSON only.",
  ].join("\n");

  let data;
  try {
    const out = await callResponsesApi({
      apiKey,
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        { role: "user", content: [{ type: "input_text", text: userPrompt }] },
      ],
      maxOutputTokens: 500,
      timeoutMs: 30_000,
      temperature: 0.2,
    });
    data = out.data;
  } catch {
    return { satisfied: false, reason: "evaluation_http_fallback" };
  }
  const text = extractResponseText(data);
  if (!text) return { satisfied: false, reason: "evaluation_empty_fallback" };
  const parsed = extractJsonObject(text);
  return {
    satisfied: parsed?.satisfied === true,
    reason: typeof parsed?.reason === "string" ? parsed.reason : "",
    next_instruction:
      typeof parsed?.next_instruction === "string" &&
      parsed.next_instruction.trim()
        ? parsed.next_instruction.trim()
        : "",
  };
}

function shouldUseIterativeDataLoop(message, decision, executionResult) {
  const text = String(message || "").toLowerCase();
  const likelyAnalytical =
    /(sum|total|count|avg|mean|max|min|largest|smallest|biggest|highest|lowest|most|least|største|højeste|laveste|gennemsnit|overblik|overview|hvilke|periode|top|bottom|group|grupp|analyse|analys|compare|compar|trend|change|growth|decline|difference|filter|sort|rank|vis mig|show me|what is|how many|how much|hvor mange|hvor meget|hvad er|beregn|calculat|fordeling|distribut|per\s|by\s)/i.test(
      text,
    );
  const op = String(decision?.action?.operation || "").toLowerCase();
  const weakOp = !op || op === "preview" || op === "columns";
  const failed = executionResult?.ok === false;
  // Use iterative loop for any failed execution, or for analytical questions
  // (even with non-weak ops, since single-shot results may be incomplete)
  return failed || likelyAnalytical;
}

async function runIterativePythonDataLoop({
  apiKey,
  model,
  message,
  history,
  skill,
  skillContexts,
  executeSkillFn,
  maxSteps = 5,
}) {
  const catalog = extractCatalogForSkill(skillContexts, skill.id);
  const planningTrace = [];
  let lastError = "";
  let lastSuccess = null;

  for (let step = 1; step <= maxSteps; step += 1) {
    let plan;
    try {
      plan = await planPythonCodeWithModel({
        apiKey,
        model,
        message: lastError
          ? `${message}\n\nPrevious error: ${lastError}`
          : message,
        history,
        skill,
        catalog,
        previousAttempts: planningTrace,
      });
    } catch (err) {
      plan = buildHeuristicPythonPlan({ message, history, catalog });
    }

    if (!plan.code) {
      plan = buildHeuristicPythonPlan({ message, history, catalog });
    }

    if (!plan.code) {
      planningTrace.push({
        step,
        ok: false,
        error: "empty generated code",
        plan,
      });
      lastError = "empty generated code";
      continue;
    }

    let executionResult;
    try {
      executionResult = await executeSkillFn(skill, {
        message,
        action: {
          file: plan.file,
          operation: "python_code",
          args: { code: plan.code, limit: plan.limit },
        },
        history,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      executionResult = { ok: false, error: reason };
    }

    if (!executionResult?.ok) {
      lastError = String(executionResult?.error || "python execution failed");
      planningTrace.push({
        step,
        ok: false,
        plan,
        error: lastError,
      });
      continue;
    }

    lastSuccess = executionResult;
    const evaluation = await evaluatePythonResultWithModel({
      apiKey,
      model,
      message,
      plan,
      executionResult,
    });

    planningTrace.push({
      step,
      ok: true,
      plan,
      evaluation,
    });

    if (evaluation.satisfied) {
      return { ok: true, executionResult, planningTrace };
    }
    lastError =
      evaluation.next_instruction ||
      evaluation.reason ||
      "result not sufficient";
  }

  if (lastSuccess) {
    return { ok: true, executionResult: lastSuccess, planningTrace };
  }
  return {
    ok: false,
    error: lastError || "iterative python planning failed",
    planningTrace,
  };
}

function buildSkillListForPrompt(skills, skillContexts) {
  return skills.map((skill) => ({
    ...summarizeSkill(skill),
    context: summarizeSkillContext(skillContexts.get(skill.id)),
  }));
}

async function routeTurnWithModel({
  apiKey,
  model,
  message,
  history,
  sessionState,
  systemEvents,
  agentContext,
  skills,
  skillContexts,
  loopState,
}) {
  if (!apiKey) {
    return normalizeRouterDecision({
      mode: "chat",
      assistant_reply: "",
    });
  }

  const systemPrompt = [
    `You are ${agentContext.agentName}.`,
    agentContext.agentRole,
    "Decide the next step for this turn.",
    "Return ONLY JSON with keys:",
    "- mode: chat | skill | clarify",
    "- skill_id: string (required when mode=skill)",
    "- action: object (required when mode=skill)",
    "- assistant_reply: optional short text",
    "- clarifying_question: required when mode=clarify",
    "- conversation_state: normal | awaiting_confirmation | awaiting_missing_param | executing",
    "- missing_fields: optional string[]",
    "- resolved_references: optional object",
    "- state_updates: optional object with session patch fields",
    "Rules:",
    "- Be autonomous: prefer action over clarification. When user intent is reasonably clear, make a decision and execute.",
    "- ALWAYS try to answer with data first. Never ask the user to narrow their question before trying. If a question is broad, actively narrow it yourself — pick the most relevant data, time range, or angle — and tell the user what choice you made. E.g. 'I focused on the last 2 weeks of marketing data since that seemed most relevant.'",
    "- Choose mode=chat for normal assistant conversation and general knowledge Q&A.",
    "- Choose mode=skill when a skill can provide value — don't wait for perfect clarity.",
    "- For data analysis requests, prefer mode=skill. Pick the most relevant file from the catalog if user didn't specify one.",
    "- For follow-up data questions that reference prior dataset context, stay in mode=skill.",
    "- Interpret short follow-ups from session state + chat history.",
    "- Resolve demonstrative references (e.g. den, den fil, samme fil, this, that file) from session state.",
    "- If awaiting_user_input is not none, treat concise user replies as continuation of the pending question.",
    "- For file-list or data-availability questions, prefer mode=chat and answer from provided skill contexts/catalog.",
    "- Follow the selected skill action_contract when constructing action payload.",
    "- Never invent skill ids. Use only listed skills.",
    "- Almost never choose mode=clarify. Instead, make your best guess, act on it, and explain what you chose. Only use mode=clarify when the request could mean two completely unrelated things with no way to guess.",
    "- When making assumptions or narrowing scope, set assistant_reply to briefly explain what you chose and why.",
    "- Keep output minimal and valid JSON.",
  ].join(" ");

  const userPrompt = [
    `User message: ${message}`,
    "",
    "Recent chat history:",
    JSON.stringify(history),
    "",
    "Session state:",
    JSON.stringify(sessionState || {}),
    "",
    "Reference memory:",
    JSON.stringify(buildReferenceMemory(sessionState)),
    "",
    "Queued system events:",
    JSON.stringify(systemEvents || []),
    "",
    "Agent context:",
    JSON.stringify(agentContext),
    "",
    "Available skills:",
    JSON.stringify(buildSkillListForPrompt(skills, skillContexts)),
    "",
    "Loop state:",
    JSON.stringify(loopState),
    "",
    "Return JSON only.",
  ].join("\n");

  const { data } = await callResponsesApi({
    apiKey,
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    maxOutputTokens: 800,
    timeoutMs: 45_000,
    temperature: 0.2,
  });
  const text = extractResponseText(data);
  if (!text) throw new Error("OpenAI route call returned empty response");
  return normalizeRouterDecision(extractJsonObject(text));
}

async function composeChatReply({
  apiKey,
  model,
  message,
  history,
  sessionState,
  systemEvents,
  agentContext,
  skills,
  skillContexts,
  prefilledReply,
}) {
  if (prefilledReply) return prefilledReply;

  if (!apiKey) {
    return "OPENAI_API_KEY mangler. Tilføj nøgle for intelligent chat og skill-routing.";
  }

  const systemPrompt = [
    `You are ${agentContext.agentName}.`,
    agentContext.agentRole,
    "Write a short, natural Telegram chat reply in the user's language.",
    "IMPORTANT: Match the language the user used in their FIRST message of the session. Do not switch language mid-conversation even if skill results or internal data are in a different language.",
    "Do NOT use markdown code blocks (``` or ```).",
    "Keep it conversational — like a helpful colleague in a chat.",
    "When relevant, briefly mention what you can help with.",
    "Do not expose internal planning.",
  ].join(" ");

  const userPrompt = [
    `User message: ${message}`,
    "",
    "Recent history:",
    JSON.stringify(history),
    "",
    "Session state:",
    JSON.stringify(sessionState || {}),
    "",
    "Reference memory:",
    JSON.stringify(buildReferenceMemory(sessionState)),
    "",
    "Queued system events:",
    JSON.stringify(systemEvents || []),
    "",
    "Agent context:",
    JSON.stringify(agentContext),
    "",
    "Active skills:",
    JSON.stringify(skills.map((s) => summarizeSkill(s))),
    "",
    "Skill contexts:",
    JSON.stringify(buildSkillListForPrompt(skills, skillContexts)),
    "",
    "Return plain text only.",
  ].join("\n");

  try {
    const { data } = await callResponsesApi({
      apiKey,
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        { role: "user", content: [{ type: "input_text", text: userPrompt }] },
      ],
      maxOutputTokens: 700,
      timeoutMs: 45_000,
    });
    return (
      extractResponseText(data) ||
      "Jeg kan ikke svare præcist lige nu. Prøv igen om et øjeblik."
    );
  } catch {
    return "Jeg kan ikke svare præcist lige nu. Prøv igen om et øjeblik.";
  }
}

async function composeSkillReply({
  apiKey,
  model,
  message,
  sessionState,
  decision,
  skill,
  executionResult,
  channelContext,
  agentContext,
  planningTrace,
}) {
  const resultSnippet = buildExecutionResultSnippet(executionResult);
  const planSnippet =
    Array.isArray(planningTrace) && planningTrace.length
      ? planningTrace
          .slice(0, 4)
          .map((step) => {
            const explain = step?.plan?.explanation
              ? `: ${step.plan.explanation}`
              : "";
            const status = step?.ok
              ? "ok"
              : `fejl (${step?.error || "ukendt"})`;
            return `- Trin ${step.step} [${status}]${explain}`;
          })
          .join("\n")
      : "";
  const fallback = [
    `Her er resultatet fra ${skill.name || skill.id}:`,
    "",
    resultSnippet,
  ].join("\n");

  if (!apiKey) return fallback;

  const systemPrompt = [
    `You are ${agentContext.agentName}.`,
    "Write a short, natural Telegram chat reply in the user's language.",
    "IMPORTANT: Match the language the user used in their FIRST message of the session. Do not switch language mid-conversation even if skill results or internal data are in a different language.",
    "ALWAYS start your reply with a human-readable summary or finding in plain text. This is the main answer.",
    "If you had to narrow the scope (e.g. picked a specific time range, file, or metric), briefly explain the choice you made so the user knows. E.g. 'I looked at the last 2 weeks since that seemed most relevant.'",
    "When the result is based on data files, show supporting data AFTER the summary as key-value pairs with a bold emoji header showing the source file.",
    "Format data snippets exactly like this:\n\n🗄️ marketing.csv\n\nlatest_date: 2026-02-25\nwindow_start: 2026-02-12\nspend_dkk_sum: 64732.64\nrows_in_window: 42",
    "When the result contains multiple data sources, write the summary first, then show each source as its own *🗄️ filename* block with key-value pairs.",
    "Do NOT reveal planning steps or internal process.",
    "Keep it conversational — like a helpful colleague replying in a chat.",
    "If useful, end with one brief follow-up suggestion.",
  ].join(" ");

  const userPrompt = [
    `User message: ${message}`,
    "",
    "Router decision:",
    JSON.stringify(decision),
    "",
    "Skill used:",
    JSON.stringify(summarizeSkill(skill)),
    "",
    "Execution result:",
    JSON.stringify(executionResult),
    "",
    "Planning trace:",
    JSON.stringify(planningTrace || []),
    "",
    "Session state:",
    JSON.stringify(sessionState || {}),
    "",
    "Reference memory:",
    JSON.stringify(buildReferenceMemory(sessionState)),
    "",
    `Channel context: ${channelContext}`,
    "",
    "Return plain text only.",
  ].join("\n");

  try {
    const { data } = await callResponsesApi({
      apiKey,
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        { role: "user", content: [{ type: "input_text", text: userPrompt }] },
      ],
      maxOutputTokens: 1200,
      timeoutMs: 45_000,
    });
    const composed = extractResponseText(data) || fallback;
    return ensureReplyContainsResult(composed, resultSnippet);
  } catch {
    return fallback;
  }
}

async function main() {
  const env = await loadEnvFile();

  const port = Number(envValue("AGENT_PORT", env, "8787")) || 8787;
  const host = envValue("AGENT_HOST", env, "127.0.0.1").trim() || "127.0.0.1";
  const apiKey = envValue("OPENAI_API_KEY", env, "").trim();
  const model =
    envValue("CODEX_MODEL", env, "gpt-5.2-codex").trim() || "gpt-5.2-codex";
  const logLevel = envValue("LOG_LEVEL", env, "info").trim().toLowerCase();

  function logDebug(label, data) {
    if (logLevel !== "debug") return;
    const ts = new Date().toISOString().slice(11, 23);
    const body =
      typeof data === "string" ? data : JSON.stringify(data, null, 2);
    console.log(`[debug ${ts}] ${label}:`, body);
  }
  _debug = logDebug;

  const memoryRootRaw =
    envValue("MEMORY_ROOT", env, "./memory").trim() || "./memory";
  const memoryRoot = path.isAbsolute(memoryRootRaw)
    ? memoryRootRaw
    : path.resolve(projectRoot, memoryRootRaw);
  const stateRootRaw =
    envValue("STATE_ROOT", env, "./state").trim() || "./state";
  const stateRoot = path.isAbsolute(stateRootRaw)
    ? stateRootRaw
    : path.resolve(projectRoot, stateRootRaw);

  const datafilesRootRaw = envValue("DATAFILES_ROOT", env, "").trim();
  const datafilesRoot = datafilesRootRaw
    ? path.isAbsolute(datafilesRootRaw)
      ? datafilesRootRaw
      : path.resolve(projectRoot, datafilesRootRaw)
    : path.join(memoryRoot, "data");

  await fs.mkdir(memoryRoot, { recursive: true });
  await fs.mkdir(datafilesRoot, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });

  const agentInstructionsPath = path.join(projectRoot, "agent", "AGENTS.md");
  const agentConfigPath = path.join(projectRoot, "agent", "config.json");

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return sendJson(res, 200, { ok: true, service: "fruit-bowl-agent" });
      }
      if (req.method === "POST" && req.url === "/agent/reset") {
        const body = await readJsonBody(req);
        const chatKey = getChatKey(body);
        const fresh = createDefaultSession(chatKey);
        await saveSession(stateRoot, fresh);
        logDebug("session reset", chatKey);
        return sendJson(res, 200, { ok: true, chat_key: chatKey });
      }
      if (req.method !== "POST" || req.url !== "/agent/turn") {
        return sendJson(res, 404, { ok: false, error: "not found" });
      }

      const body = await readJsonBody(req);
      const message =
        typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        return sendJson(res, 400, { ok: false, error: "message is required" });
      }

      const [agentInstructions, agentConfigRaw, memorySnapshot] =
        await Promise.all([
          readUtf8IfExists(agentInstructionsPath),
          readUtf8IfExists(agentConfigPath),
          buildMemorySnapshot(memoryRoot),
        ]);

      let agentConfig = {};
      try {
        agentConfig = agentConfigRaw ? JSON.parse(agentConfigRaw) : {};
      } catch {
        agentConfig = {};
      }

      const skills = await loadSkillsRuntime({
        projectRoot,
        memoryRoot,
        datafilesRoot,
      });
      logDebug(
        "skills loaded",
        skills.map((s) => s.id),
      );
      const skillContexts = new Map();
      await Promise.all(
        skills.map(async (skill) => {
          try {
            const ctx = await getSkillContext(skill, 30_000);
            skillContexts.set(skill.id, ctx);
            logDebug(`skill context [${skill.id}]`, {
              ok: ctx?.ok,
              keys: Object.keys(ctx || {}),
            });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            skillContexts.set(skill.id, { ok: false, error: reason });
            logDebug(`skill context [${skill.id}] FAILED`, reason);
          }
        }),
      );

      const chatKey = getChatKey(body);
      let session = await loadSession(stateRoot, chatKey);
      let drained = consumeEvents(session);
      session = drained.session;
      const systemEvents = drained.events;
      const history = getRecentHistory(session, MAX_CHAT_HISTORY);
      const sessionState = buildSessionPromptState(session);
      const channelContext = body?.source?.channel
        ? `channel=${String(body.source.channel)}, chatId=${String(body.chatId ?? "unknown")}`
        : `channel=unknown, chatId=${String(body.chatId ?? "unknown")}`;

      const agentContext = {
        agentName:
          typeof agentConfig?.agentName === "string" &&
          agentConfig.agentName.trim()
            ? agentConfig.agentName.trim()
            : DEFAULT_AGENT_NAME,
        agentRole:
          typeof agentConfig?.agentRole === "string" &&
          agentConfig.agentRole.trim()
            ? agentConfig.agentRole.trim()
            : DEFAULT_AGENT_ROLE,
        notes:
          typeof agentConfig?.notes === "string" && agentConfig.notes.trim()
            ? agentConfig.notes.trim()
            : "",
        memorySnapshot: {
          byCategory: memorySnapshot.byCategory,
          files: memorySnapshot.files.slice(0, 50),
        },
        instructionsExcerpt: agentInstructions.slice(0, 4000),
      };

      const maxAttempts = 3;
      const attempts = [];
      let finalDecision = null;
      let finalSkill = null;
      let finalResult = null;
      let lastError = "";

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let decision;
        try {
          decision = await routeTurnWithModel({
            apiKey,
            model,
            message,
            history,
            sessionState,
            systemEvents,
            agentContext,
            skills,
            skillContexts,
            loopState: {
              attempt,
              max_attempts: maxAttempts,
              last_error: lastError || null,
              attempts,
            },
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logDebug(`router error (attempt ${attempt})`, reason);
          decision = normalizeRouterDecision({
            mode: "chat",
            assistant_reply: "",
          });
        }

        logDebug(`router decision (attempt ${attempt})`, {
          mode: decision.mode,
          skill_id: decision.skill_id,
          action: decision.action,
          reply: decision.assistant_reply?.slice(0, 120),
          state: decision.conversation_state,
        });

        finalDecision = decision;

        // If router resolved a file reference but omitted action.file, bind it automatically.
        if (decision.mode === "skill") {
          const refFile =
            typeof decision?.resolved_references?.file === "string"
              ? decision.resolved_references.file.trim()
              : "";
          const actionFile =
            typeof decision?.action?.file === "string"
              ? decision.action.file.trim()
              : "";
          if (refFile && !actionFile) {
            decision.action = { ...(decision.action || {}), file: refFile };
          }
        }

        if (decision.mode === "chat") {
          const reply = await composeChatReply({
            apiKey,
            model,
            message,
            history,
            sessionState,
            systemEvents,
            agentContext,
            skills,
            skillContexts,
            prefilledReply: decision.assistant_reply,
          });
          logDebug("chat reply", reply.slice(0, 300));
          session = appendSessionHistory(
            session,
            "user",
            message,
            MAX_SESSION_HISTORY,
          );
          session = appendSessionHistory(
            session,
            "assistant",
            reply,
            MAX_SESSION_HISTORY,
          );
          session = applySessionStatePatch(session, {
            ...(decision.state_updates || {}),
            conversation_state: decision.conversation_state || "normal",
            awaiting_user_input: "none",
            missing_fields: [],
            last_error: "",
          });
          await saveSession(stateRoot, session);
          return sendJson(res, 200, {
            ok: true,
            reply,
            mode: "chat",
            metadata: {
              activeSkills: skills.map((s) => s.id),
              memoryCategories: Object.keys(memorySnapshot.byCategory).length,
            },
          });
        }

        if (decision.mode === "clarify") {
          const reply =
            decision.clarifying_question ||
            decision.assistant_reply ||
            "Kan du beskrive kort hvad du vil have hjælp til?";
          session = appendSessionHistory(
            session,
            "user",
            message,
            MAX_SESSION_HISTORY,
          );
          session = appendSessionHistory(
            session,
            "assistant",
            reply,
            MAX_SESSION_HISTORY,
          );
          session = applySessionStatePatch(session, {
            ...(decision.state_updates || {}),
            conversation_state:
              decision.conversation_state || "awaiting_missing_param",
            awaiting_user_input:
              decision.conversation_state === "awaiting_confirmation"
                ? "confirmation"
                : "missing_param",
            missing_fields: decision.missing_fields || [],
            active_plan: decision.assistant_reply || "",
          });
          session = pushEvent(
            session,
            `Clarification requested: ${reply}`,
            "clarify",
          );
          await saveSession(stateRoot, session);
          return sendJson(res, 200, {
            ok: true,
            reply,
            mode: "clarify",
            metadata: {
              activeSkills: skills.map((s) => s.id),
            },
          });
        }

        const skill = skills.find((s) => s.id === decision.skill_id);
        if (!skill) {
          lastError = `unknown skill_id: ${decision.skill_id || "(empty)"}`;
          session = pushEvent(session, lastError, "error");
          attempts.push({ attempt, decision, ok: false, error: lastError });
          if (attempt >= maxAttempts) break;
          continue;
        }

        finalSkill = skill;
        let planningTrace = null;
        let executionResult;
        try {
          executionResult = await executeSkill(
            skill,
            {
              message,
              action: decision.action,
              history,
            },
            45_000,
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          executionResult = { ok: false, error: reason };
        }

        logDebug(`skill exec [${skill.id}]`, {
          ok: executionResult?.ok,
          error: executionResult?.error,
          resultPreview:
            typeof executionResult?.result === "string"
              ? executionResult.result.slice(0, 200)
              : undefined,
        });

        const shouldIterate =
          skillSupportsOperation(skill, "python_code") &&
          shouldUseIterativeDataLoop(message, decision, executionResult);
        if (shouldIterate) {
          try {
            const iterative = await runIterativePythonDataLoop({
              apiKey,
              model,
              message,
              history,
              skill,
              skillContexts,
              executeSkillFn: executeSkill,
              maxSteps: 5,
            });
            planningTrace = iterative.planningTrace || null;
            if (iterative.ok && iterative.executionResult) {
              executionResult = iterative.executionResult;
            } else if (!executionResult?.ok) {
              executionResult = {
                ok: false,
                error: iterative.error || "iterative analysis failed",
              };
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (!executionResult?.ok) {
              executionResult = { ok: false, error: reason };
            }
          }
        }

        if (!executionResult?.ok) {
          lastError = String(
            executionResult?.error || "skill execution failed",
          );
          session = pushEvent(
            session,
            `Skill failed (${skill.id}): ${lastError}`,
            "error",
          );
          attempts.push({
            attempt,
            decision,
            skill_id: skill.id,
            ok: false,
            error: lastError,
            planningTrace,
          });
          if (attempt >= maxAttempts) {
            finalResult = executionResult;
            break;
          }
          continue;
        }

        finalResult = executionResult;
        attempts.push({
          attempt,
          decision,
          skill_id: skill.id,
          ok: true,
          planningTrace,
        });

        const reply = await composeSkillReply({
          apiKey,
          model,
          message,
          sessionState: buildSessionPromptState(session),
          decision,
          skill,
          executionResult,
          channelContext,
          agentContext,
          planningTrace,
        });
        logDebug("skill reply", reply.slice(0, 300));

        session = appendSessionHistory(
          session,
          "user",
          message,
          MAX_SESSION_HISTORY,
        );
        session = appendSessionHistory(
          session,
          "assistant",
          reply,
          MAX_SESSION_HISTORY,
        );
        const selectedFile =
          typeof decision?.resolved_references?.file === "string"
            ? decision.resolved_references.file
            : typeof decision?.action?.file === "string"
              ? decision.action.file
              : session.last_selected_file;
        session = applySessionStatePatch(session, {
          ...(decision.state_updates || {}),
          conversation_state: decision.conversation_state || "normal",
          awaiting_user_input: "none",
          missing_fields: [],
          active_skill_id: skill.id,
          active_plan:
            (Array.isArray(planningTrace) && planningTrace.length > 0
              ? planningTrace
                  .map((step) => String(step?.plan?.explanation || "").trim())
                  .filter(Boolean)
                  .join(" | ")
              : "") || session.active_plan,
          last_selected_file: selectedFile || "",
          last_result_summary: summarizeExecutionResult(executionResult),
          last_error: "",
        });
        session = pushEvent(session, `Skill succeeded (${skill.id})`, "skill");
        await saveSession(stateRoot, session);

        return sendJson(res, 200, {
          ok: true,
          reply,
          mode: "skill",
          skill_id: skill.id,
          turn: decision,
          executor: executionResult,
          trace: attempts,
        });
      }

      const fallbackReply = [
        "Jeg kunne ikke fuldføre opgaven sikkert endnu.",
        finalSkill
          ? `Seneste skillforsøg: ${finalSkill.id}`
          : "Ingen skill blev valgt endeligt.",
        finalResult?.error
          ? `Fejl: ${finalResult.error}`
          : lastError
            ? `Fejl: ${lastError}`
            : "",
        "Beskriv gerne ønsket resultat i én sætning, så prøver jeg igen med en ny strategi.",
      ]
        .filter(Boolean)
        .join("\n");

      session = appendSessionHistory(
        session,
        "user",
        message,
        MAX_SESSION_HISTORY,
      );
      session = appendSessionHistory(
        session,
        "assistant",
        fallbackReply,
        MAX_SESSION_HISTORY,
      );
      session = applySessionStatePatch(session, {
        conversation_state: "awaiting_missing_param",
        awaiting_user_input: "missing_param",
        last_error:
          finalResult?.error || lastError || "unable to complete task",
      });
      session = pushEvent(
        session,
        `Fallback reply returned: ${finalResult?.error || lastError || "unknown error"}`,
        "error",
      );
      await saveSession(stateRoot, session);
      return sendJson(res, 200, {
        ok: true,
        reply: fallbackReply,
        mode: finalDecision?.mode || "clarify",
        turn: finalDecision,
        trace: attempts,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sendJson(res, 500, { ok: false, error: message });
    }
  });

  server.listen(port, host, () => {
    console.log("Fruit Bowl Agent started");
    console.log(`- URL: http://${host}:${port}/agent/turn`);
    console.log(`- MEMORY_ROOT: ${memoryRoot}`);
    console.log(`- DATAFILES_ROOT: ${datafilesRoot}`);
    console.log(`- STATE_ROOT: ${stateRoot}`);
    console.log(`- CODEX_MODEL: ${model}`);
    console.log(
      `- OPENAI_API_KEY: ${apiKey ? "set" : "not set (fallback mode)"}`,
    );
  });
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  console.error(message);
  process.exit(1);
});
