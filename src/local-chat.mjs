import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

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

async function fetchJsonWithTimeout(url, init, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

function formatMs(ms) {
  return `${Math.round(ms)}ms`;
}

function printHelp() {
  console.log("\nLocal Chat commands:");
  console.log("  /help      Show commands");
  console.log("  /raw       Toggle raw JSON output");
  console.log("  /health    Check agent health endpoint");
  console.log("  /history   Show local prompt history");
  console.log("  /exit      Exit local chat\n");
}

async function main() {
  const env = await loadEnvFile();
  const agentEndpointUrl =
    envValue("AGENT_ENDPOINT_URL", env, "http://127.0.0.1:8787/agent/turn").trim() ||
    "http://127.0.0.1:8787/agent/turn";
  const healthUrl = agentEndpointUrl.replace(/\/agent\/turn\/?$/, "/health");
  const chatId = envValue("LOCAL_CHAT_ID", env, "local-test").trim() || "local-test";

  let showRaw = envValue("LOCAL_CHAT_SHOW_RAW", env, "false").trim().toLowerCase() === "true";
  const history = [];

  console.log("Fruit Bowl Local Test Chat");
  console.log(`- Agent endpoint: ${agentEndpointUrl}`);
  console.log(`- Health endpoint: ${healthUrl}`);
  console.log(`- Chat id: ${chatId}`);
  console.log(`- Raw debug: ${showRaw}`);

  const rl = readline.createInterface({ input, output });

  try {
    printHelp();

    while (true) {
      const prompt = await rl.question("you> ");
      const text = String(prompt || "").trim();
      if (!text) continue;

      if (text === "/exit" || text === "/quit") {
        break;
      }
      if (text === "/help") {
        printHelp();
        continue;
      }
      if (text === "/raw") {
        showRaw = !showRaw;
        console.log(`raw debug: ${showRaw}`);
        continue;
      }
      if (text === "/history") {
        if (!history.length) {
          console.log("(no local history yet)");
        } else {
          for (const row of history.slice(-20)) {
            console.log(`${row.role}> ${row.text}`);
          }
        }
        continue;
      }
      if (text === "/health") {
        const t0 = Date.now();
        try {
          const { res, data } = await fetchJsonWithTimeout(healthUrl, { method: "GET" }, 8_000);
          console.log(`health: ${res.status} (${formatMs(Date.now() - t0)}) ${JSON.stringify(data)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`health error: ${msg}`);
        }
        continue;
      }

      history.push({ role: "you", text });
      const t0 = Date.now();
      try {
        const { res, data } = await fetchJsonWithTimeout(
          agentEndpointUrl,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: text,
              chatId,
              source: {
                channel: "local-test-chat",
                transport: "terminal",
              },
            }),
          },
          120_000,
        );

        const dt = formatMs(Date.now() - t0);
        if (!res.ok || !data?.ok) {
          console.log(`agent error [${res.status}] (${dt}): ${data?.error || "unknown"}`);
          if (showRaw) {
            console.log(JSON.stringify(data, null, 2));
          }
          continue;
        }

        const reply = typeof data.reply === "string" ? data.reply : "(empty reply)";
        history.push({ role: "agent", text: reply });
        console.log(`agent (${dt})> ${reply}`);

        if (showRaw) {
          const raw = {
            mode: data.mode,
            skill_id: data.skill_id,
            turn: data.turn,
            trace: data.trace,
            executor: data.executor,
            metadata: data.metadata,
          };
          console.log("\n[raw]");
          console.log(JSON.stringify(raw, null, 2));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`request error: ${msg}`);
      }
    }
  } finally {
    rl.close();
  }

  console.log("Local test chat stopped.");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  console.error(msg);
  process.exit(1);
});
