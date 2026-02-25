import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

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
    const raw = await fs.readFile(envPath, "utf8");
    return parseDotEnv(raw);
  } catch {
    return new Map();
  }
}

function envValue(key, fileMap, fallback = "") {
  if (process.env[key] !== undefined) return process.env[key];
  if (fileMap.has(key)) return fileMap.get(key);
  return fallback;
}

function isPathInside(candidate, root) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function splitWriteLike(rest) {
  const sep = rest.indexOf("|");
  if (sep === -1) {
    return { filePath: "", text: "" };
  }
  const filePath = rest.slice(0, sep).trim();
  const text = rest.slice(sep + 1).trim();
  return { filePath, text };
}

function parseCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { cmd: "", rest: "" };
  }
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return { cmd: trimmed.toLowerCase(), rest: "" };
  }
  return {
    cmd: trimmed.slice(0, firstSpace).toLowerCase(),
    rest: trimmed.slice(firstSpace + 1).trim(),
  };
}

function parseAllowedUserIds(raw) {
  const cleaned = String(raw || "").trim();
  if (!cleaned) return [];
  const ids = cleaned
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  return Array.from(new Set(ids));
}

function buildHelpText() {
  return [
    "Fruit Bowl AI commands:",
    "/help - show this help",
    "/agent <text> - send instruction to the local agent endpoint",
    "/pwd - show allowed root directory",
    "/ls [dir] - list files",
    "/read <file> - read a file",
    "/write <file> | <text> - overwrite file",
    "/append <file> | <text> - append text",
    "/mkdir <dir> - create directory",
    "/delete <path> - delete file or empty dir",
  ].join("\n");
}

async function createApi(token) {
  const baseUrl = `https://api.telegram.org/bot${token}`;

  async function call(method, payload) {
    const res = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.description || `Telegram API error: ${method}`);
    }
    return data.result;
  }

  return {
    async getUpdates(offset) {
      return call("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      });
    },
    async sendMessage(chatId, text) {
      const maxLen = 3900;
      if (text.length <= maxLen) {
        return call("sendMessage", { chat_id: chatId, text });
      }
      const chunks = [];
      let remaining = text;
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, maxLen));
        remaining = remaining.slice(maxLen);
      }
      for (const chunk of chunks) {
        await call("sendMessage", { chat_id: chatId, text: chunk });
      }
    },
    async sendChatAction(chatId, action = "typing") {
      return call("sendChatAction", { chat_id: chatId, action });
    },
  };
}

function isLikelyLongAnalysis(text) {
  const t = String(text || "").toLowerCase();
  return /(analy|analyse|sum|total|største|højeste|laveste|gennemsnit|group|grupp|dato|dates?|filter|python|script|overblik|overview|værdier|value)/i.test(
    t,
  );
}

async function main() {
  const envFile = await loadEnvFile();
  const token = envValue("TELEGRAM_BOT_TOKEN", envFile).trim();
  const allowedChatRaw = envValue("ALLOWED_CHAT_ID", envFile).trim();
  const allowedUsersRaw =
    envValue("ALLOWED_USER_IDS", envFile, "").trim() || envValue("ALLOWED_USER_ID", envFile, "").trim();
  const fileRootRaw = envValue("FILE_ROOT", envFile, "./memory").trim() || "./memory";
  const agentEndpointUrl =
    envValue("AGENT_ENDPOINT_URL", envFile, "http://127.0.0.1:8787/agent/turn").trim() ||
    "http://127.0.0.1:8787/agent/turn";
  const agentRoutingEnabled =
    envValue("ENABLE_AGENT_ROUTING", envFile, "true").trim().toLowerCase() !== "false";
  const logLevel = envValue("LOG_LEVEL", envFile, "info").trim().toLowerCase();

  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN. Set it in .env or environment.");
  }

  const allowedChatId = allowedChatRaw ? Number(allowedChatRaw) : null;
  if (allowedChatRaw && Number.isNaN(allowedChatId)) {
    throw new Error("ALLOWED_CHAT_ID must be a numeric Telegram chat id.");
  }
  const allowedUserIds = parseAllowedUserIds(allowedUsersRaw);
  if (allowedUsersRaw && allowedUserIds.length === 0) {
    throw new Error("ALLOWED_USER_IDS must contain one or more numeric Telegram user ids.");
  }
  const allowedUsersSet = new Set(allowedUserIds);

  const fileRoot = path.isAbsolute(fileRootRaw)
    ? fileRootRaw
    : path.resolve(projectRoot, fileRootRaw);

  await fs.mkdir(fileRoot, { recursive: true });
  const fileRootReal = await fs.realpath(fileRoot);

  const api = await createApi(token);

  let stopRequested = false;
  process.on("SIGINT", () => {
    stopRequested = true;
  });
  process.on("SIGTERM", () => {
    stopRequested = true;
  });

  function logDebug(...args) {
    if (logLevel === "debug") {
      console.log("[debug]", ...args);
    }
  }

  async function askAgent(message, chatId) {
    const controller = new AbortController();
    const timeoutMs = 120_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(agentEndpointUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          chatId,
          source: {
            channel: "telegram",
            transport: "bot_api_long_polling",
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const causeCode =
        err && typeof err === "object" && "cause" in err && err.cause && typeof err.cause === "object"
          ? err.cause.code
          : undefined;
      if (causeCode === "ECONNREFUSED") {
        throw new Error(
          `Agent endpoint is not reachable (${agentEndpointUrl}). Start it with: npm run start:agent`,
        );
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Agent request timed out after ${timeoutMs / 1000}s. Try again or check agent logs in the start:agent terminal.`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Agent request failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Agent endpoint error (${res.status})`);
    }
    if (!data.ok) {
      throw new Error(data.error || "Agent endpoint returned failure");
    }
    return typeof data.reply === "string" && data.reply.trim() ? data.reply : "(empty agent reply)";
  }

  async function resolveTargetRelative(input, options = { mustExist: true }) {
    const rel = (input || ".").trim();
    if (!rel) throw new Error("Path is required.");
    if (path.isAbsolute(rel)) {
      throw new Error("Use paths relative to FILE_ROOT.");
    }

    const candidate = path.resolve(fileRootReal, rel);
    if (!isPathInside(candidate, fileRootReal)) {
      throw new Error("Path escapes FILE_ROOT.");
    }

    if (options.mustExist) {
      const real = await fs.realpath(candidate);
      if (!isPathInside(real, fileRootReal)) {
        throw new Error("Resolved path escapes FILE_ROOT.");
      }
      return candidate;
    }

    const parent = path.dirname(candidate);
    const parentReal = await fs.realpath(parent);
    if (!isPathInside(parentReal, fileRootReal)) {
      throw new Error("Parent directory escapes FILE_ROOT.");
    }
    return candidate;
  }

  async function handleCommand(text, chatId) {
    const { cmd, rest } = parseCommand(text);

    if (!cmd || cmd === "/help" || cmd === "/start") {
      return buildHelpText();
    }

    if (cmd === "/agent") {
      if (!rest) throw new Error("Usage: /agent <instruction>");
      return askAgent(rest, chatId);
    }

    if (cmd === "/pwd") {
      return `FILE_ROOT: ${fileRootReal}`;
    }

    if (cmd === "/ls") {
      const rel = rest || ".";
      const target = await resolveTargetRelative(rel, { mustExist: true });
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) {
        throw new Error("Target is not a directory.");
      }
      const entries = await fs.readdir(target, { withFileTypes: true });
      if (entries.length === 0) {
        return "(empty directory)";
      }
      const lines = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => `${e.isDirectory() ? "[DIR] " : "[FILE]"} ${e.name}`);
      return lines.join("\n");
    }

    if (cmd === "/read") {
      if (!rest) throw new Error("Usage: /read <file>");
      const target = await resolveTargetRelative(rest, { mustExist: true });
      const stat = await fs.stat(target);
      if (!stat.isFile()) {
        throw new Error("Target is not a file.");
      }
      const raw = await fs.readFile(target, "utf8");
      const content = raw.length > 12000 ? `${raw.slice(0, 12000)}\n\n...[truncated]` : raw;
      return content || "(empty file)";
    }

    if (cmd === "/mkdir") {
      if (!rest) throw new Error("Usage: /mkdir <dir>");
      const target = await resolveTargetRelative(rest, { mustExist: false });
      await fs.mkdir(target, { recursive: true });
      return `Created directory: ${rest}`;
    }

    if (cmd === "/write") {
      const { filePath, text: body } = splitWriteLike(rest);
      if (!filePath) throw new Error("Usage: /write <file> | <text>");
      const target = await resolveTargetRelative(filePath, { mustExist: false });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body, "utf8");
      return `Wrote ${body.length} chars to ${filePath}`;
    }

    if (cmd === "/append") {
      const { filePath, text: body } = splitWriteLike(rest);
      if (!filePath) throw new Error("Usage: /append <file> | <text>");
      const target = await resolveTargetRelative(filePath, { mustExist: false });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.appendFile(target, body + "\n", "utf8");
      return `Appended ${body.length} chars to ${filePath}`;
    }

    if (cmd === "/delete") {
      if (!rest) throw new Error("Usage: /delete <path>");
      const target = await resolveTargetRelative(rest, { mustExist: true });
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        await fs.rmdir(target);
        return `Deleted empty directory: ${rest}`;
      }
      await fs.unlink(target);
      return `Deleted file: ${rest}`;
    }

    return `Unknown command: ${cmd}\nUse /help`;
  }

  console.log("Fruit Bowl AI started");
  console.log(`- FILE_ROOT: ${fileRootReal}`);
  console.log(`- AGENT_ENDPOINT_URL: ${agentEndpointUrl}`);
  console.log(`- ENABLE_AGENT_ROUTING: ${agentRoutingEnabled}`);
  if (allowedChatId !== null) {
    console.log(`- ALLOWED_CHAT_ID: ${allowedChatId}`);
  } else {
    console.log("- ALLOWED_CHAT_ID: not set (accepting all chats)");
  }
  if (allowedUserIds.length > 0) {
    console.log(`- ALLOWED_USER_IDS: ${allowedUserIds.join(", ")}`);
  } else {
    console.log("- ALLOWED_USER_IDS: not set (accepting all users)");
  }

  let offset = 0;
  while (!stopRequested) {
    try {
      const updates = await api.getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || typeof msg.text !== "string") continue;

        const chatId = Number(msg.chat?.id);
        if (!Number.isFinite(chatId)) continue;
        const userId = Number(msg.from?.id);

        if (allowedChatId !== null && chatId !== allowedChatId) {
          logDebug("Rejected message from unauthorized chat", chatId);
          continue;
        }
        if (allowedUsersSet.size > 0) {
          if (!Number.isFinite(userId) || !allowedUsersSet.has(userId)) {
            logDebug("Rejected message from unauthorized user", {
              chatId,
              userId: Number.isFinite(userId) ? userId : "(missing)",
            });
            continue;
          }
        }

        logDebug("Incoming message", { chatId, userId, text: msg.text });

        try {
          const text = msg.text.trim();
          const isCommand = text.startsWith("/");
          let response;
          if (isCommand) {
            response = await handleCommand(text, chatId);
          } else if (agentRoutingEnabled) {
            const shouldShowProgress = isLikelyLongAnalysis(text);
            let done = false;
            let progressTimer = null;
            if (shouldShowProgress) {
              api.sendChatAction(chatId, "typing").catch(() => {});
              progressTimer = setTimeout(() => {
                if (done) return;
                api.sendChatAction(chatId, "typing").catch(() => {});
              }, 2500);
            }
            try {
              response = await askAgent(text, chatId);
            } finally {
              done = true;
              if (progressTimer) clearTimeout(progressTimer);
            }
          } else {
            response = "Agent routing disabled. Use /help for local file commands.";
          }
          await api.sendMessage(chatId, response);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await api.sendMessage(chatId, `Error: ${message}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Polling error:", message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log("Fruit Bowl AI stopped");
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  console.error(message);
  process.exit(1);
});
