import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const HOST = process.env.SELFTEST_AGENT_HOST || "127.0.0.1";
const PORT = Number(process.env.SELFTEST_AGENT_PORT || "8791");
const BASE_URL = `http://${HOST}:${PORT}`;
const ENDPOINT = `${BASE_URL}/agent/turn`;

const BASE_PROMPTS = [
  "Hej!",
  "Hvilke filer har jeg?",
  "Giv et overblik af transformed financial",
  "Ja tak",
  "Forstår du spørgsmålet?",
];

async function loadSkillPrompts() {
  const registryPath = path.join(projectRoot, "agent", "skills", "index.json");
  let parsed = { skills: [] };
  try {
    parsed = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read skill registry: ${msg}`);
  }

  const skills = Array.isArray(parsed?.skills) ? parsed.skills : [];
  const enabledSkills = skills.filter((s) => s && s.enabled !== false);
  const missing = enabledSkills
    .filter((s) => !Array.isArray(s.self_test_questions) || s.self_test_questions.length === 0)
    .map((s) => s.id || "(unknown)");
  if (missing.length > 0) {
    throw new Error(
      `enabled skills missing self_test_questions: ${missing.join(", ")}. Add test questions in agent/skills/index.json.`,
    );
  }

  const prompts = [];
  const promptsBySkill = {};
  for (const skill of enabledSkills) {
    const skillId = String(skill.id || "").trim() || "(unknown)";
    const qs = (skill.self_test_questions || [])
      .map((q) => String(q || "").trim())
      .filter(Boolean);
    promptsBySkill[skillId] = qs;
    prompts.push(...qs);
  }

  return { prompts, promptsBySkill };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init, timeoutMs = 90_000) {
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

async function waitForHealth(deadlineMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const { res } = await fetchJson(`${BASE_URL}/health`, { method: "GET" }, 3_000);
      if (res.ok) return true;
    } catch {
      // keep polling
    }
    await sleep(350);
  }
  return false;
}

function hasBadFallback(text) {
  return (
    /Jeg kunne ikke planlægge næste skridt/i.test(text || "") ||
    /Jeg kunne ikke fuldføre opgaven sikkert endnu/i.test(text || "")
  );
}

function hasConcreteOutput(text) {
  if (!text) return false;
  if (/```text[\s\S]*```/i.test(text)) return true;
  if (/Resultat:\s*/i.test(text)) return true;
  if (/\b\d{2}\.\d{2}\.\d{4}\b/.test(text)) return true;
  return false;
}

function hasFileListOutput(text) {
  if (!text) return false;
  return (
    /filer/i.test(text) &&
    (/\.(csv|xlsx|xls|parquet)\b/i.test(text) ||
      /Datafiler via aktive skills/i.test(text) ||
      /Memory-filer/i.test(text))
  );
}

async function run() {
  const { promptsBySkill } = await loadSkillPrompts();
  const runKey = `run-${Date.now().toString(36)}`;

  const child = spawn("node", ["src/agent-server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AGENT_HOST: HOST,
      AGENT_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (d) => {
    logs += d.toString("utf8");
  });
  child.stderr.on("data", (d) => {
    logs += d.toString("utf8");
  });

  try {
    const healthy = await waitForHealth();
    if (!healthy) {
      throw new Error(`agent health check failed. Logs:\n${logs}`);
    }

    const results = [];
    const runTurn = async (prompt, chatId, meta = {}) => {
      const { res, data } = await fetchJson(
        ENDPOINT,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: prompt,
            chatId,
            source: { channel: "self-test", transport: "script" },
          }),
        },
        120_000,
      );

      const reply = typeof data?.reply === "string" ? data.reply : "";
      const failed = !res.ok || !data?.ok || hasBadFallback(reply);
      const row = {
        prompt,
        status: failed ? "FAIL" : "OK",
        mode: data?.mode || "",
        skill_id: data?.skill_id || "",
        reply,
        chatId,
        ...meta,
      };
      results.push(row);
      return row;
    };

    for (const prompt of BASE_PROMPTS) {
      await runTurn(prompt, `selftest-base-${runKey}`);
    }

    for (const [skillId, skillQs] of Object.entries(promptsBySkill)) {
      const chatId = `selftest-skill-${skillId}-${runKey}`;
      for (const prompt of skillQs) {
        await runTurn(prompt, chatId, { expected_skill: skillId });
      }
    }

    console.log("Self-test transcript:\n");
    for (const row of results) {
      console.log(`Prompt: ${row.prompt}`);
      console.log(
        `Status: ${row.status} | mode=${row.mode || "-"} | skill=${row.skill_id || "-"} | chat=${row.chatId || "-"}`,
      );
      console.log(`Reply: ${row.reply || "(empty)"}`);
      console.log("---");
    }

    const failures = results.filter((r) => r.status === "FAIL");
    const fileListPrompt = results.find((r) => /hvilke filer har jeg/i.test(r.prompt));
    if (!fileListPrompt || !hasFileListOutput(fileListPrompt.reply)) {
      throw new Error("Self-test failed: file inventory question did not return a file-list style response.");
    }
    const perSkillOutputFailures = [];
    for (const [skillId, skillQs] of Object.entries(promptsBySkill)) {
      for (const q of skillQs) {
        const row = results.find((r) => r.prompt === q);
        if (!row) {
          perSkillOutputFailures.push(`${skillId}: missing result row for prompt "${q}"`);
          continue;
        }
        if (!hasConcreteOutput(row.reply)) {
          perSkillOutputFailures.push(`${skillId}: no concrete output for prompt "${q}"`);
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`Self-test failed with ${failures.length} failing turn(s).`);
    }
    if (perSkillOutputFailures.length > 0) {
      throw new Error(`Self-test failed output checks: ${perSkillOutputFailures.join(" | ")}`);
    }

    console.log("Self-test passed.");
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

run().catch((err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  console.error(msg);
  process.exit(1);
});
