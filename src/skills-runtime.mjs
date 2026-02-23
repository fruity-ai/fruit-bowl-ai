import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

function replaceTemplates(value, vars) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : "";
  });
}

function deepReplaceTemplates(value, vars) {
  if (Array.isArray(value)) return value.map((v) => deepReplaceTemplates(v, vars));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepReplaceTemplates(v, vars);
    }
    return out;
  }
  return replaceTemplates(value, vars);
}

function resolvePathFromProject(projectRoot, maybePath) {
  if (!maybePath || typeof maybePath !== "string") return "";
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(projectRoot, maybePath);
}

function runPythonJson(scriptPath, payload, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error(`python worker timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        // ignore parse errors and report raw text below
      }

      if (code === 0 && parsed) {
        resolve(parsed);
        return;
      }
      if (parsed && parsed.ok === false) {
        resolve(parsed);
        return;
      }

      reject(
        new Error(
          `python worker failed (code ${code ?? "?"}) ${stderr || stdout || "no output"}`,
        ),
      );
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function loadSkillsRuntime({ projectRoot, memoryRoot, datafilesRoot }) {
  const registryPath = path.join(projectRoot, "agent", "skills", "index.json");
  let parsed = { skills: [] };
  try {
    parsed = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch {
    parsed = { skills: [] };
  }

  const skills = Array.isArray(parsed?.skills) ? parsed.skills : [];
  const vars = {
    PROJECT_ROOT: projectRoot,
    MEMORY_ROOT: memoryRoot,
    DATAFILES_ROOT: datafilesRoot,
  };

  return skills
    .filter((s) => s && s.enabled !== false && typeof s.id === "string" && s.id.trim())
    .map((skill) => {
      const replaced = deepReplaceTemplates(skill, vars);
      const rootRaw = replaced.root || "${MEMORY_ROOT}";
      const rootResolved = resolvePathFromProject(projectRoot, rootRaw);
      const executor = replaced.executor && typeof replaced.executor === "object" ? replaced.executor : {};
      const operations = Array.isArray(replaced.operations) ? replaced.operations : [];
      const examples = Array.isArray(replaced.examples) ? replaced.examples : [];
      return {
        ...replaced,
        projectRoot,
        memoryRoot,
        root: rootRaw,
        rootResolved,
        operations,
        examples,
        executor,
      };
    });
}

function buildSkillPayload(skill, kind, input = {}) {
  const section = skill?.executor?.[kind] && typeof skill.executor[kind] === "object" ? skill.executor[kind] : {};
  const basePayload = section.payload && typeof section.payload === "object" ? section.payload : {};
  const mode = typeof section.mode === "string" && section.mode.trim() ? section.mode.trim() : undefined;

  return {
    ...(mode ? { mode } : {}),
    ...basePayload,
    ...input,
    ...(skill.rootResolved
      ? {
          skill_root: skill.rootResolved,
          data_root: skill.rootResolved,
        }
      : {}),
    ...(skill.memoryRoot ? { memory_root: skill.memoryRoot } : {}),
    ...(skill.projectRoot ? { project_root: skill.projectRoot } : {}),
  };
}

function getTimeout(skill, kind, fallbackMs) {
  const key = kind === "context" ? "contextTimeoutMs" : "executeTimeoutMs";
  const raw = Number(skill?.executor?.[key]);
  if (!Number.isFinite(raw) || raw <= 0) return fallbackMs;
  return Math.floor(raw);
}

async function executeNodeModule(skill, payload, kind) {
  const modulePathRaw = skill?.executor?.module;
  if (!modulePathRaw) {
    throw new Error(`skill ${skill.id} missing executor.module`);
  }
  const modulePath = resolvePathFromProject(skill.projectRoot || process.cwd(), modulePathRaw);
  const mod = await import(pathToFileURL(modulePath).href);
  if (kind === "context" && typeof mod.getContext === "function") {
    return await mod.getContext(payload);
  }
  if (typeof mod.execute !== "function") {
    throw new Error(`skill ${skill.id} module must export execute(payload)`);
  }
  return await mod.execute(payload);
}

export async function getSkillContext(skill, timeoutMs = 30_000) {
  const effectiveTimeout = getTimeout(skill, "context", timeoutMs);
  const type = skill?.executor?.type;
  if (type === "python_stdio") {
    const scriptPath = resolvePathFromProject(skill.projectRoot || process.cwd(), skill?.executor?.script);
    if (!scriptPath) return { ok: false, error: "missing executor.script" };
    const payload = buildSkillPayload(skill, "context", {});
    if (!payload.mode) return { ok: true, skipped: true };
    return await runPythonJson(scriptPath, payload, effectiveTimeout);
  }
  if (type === "node_module") {
    const payload = buildSkillPayload(skill, "context", {});
    return await executeNodeModule(skill, payload, "context");
  }
  return { ok: false, error: `unsupported executor type for context: ${type || "missing"}` };
}

export async function executeSkill(skill, input, timeoutMs = 45_000) {
  const effectiveTimeout = getTimeout(skill, "execute", timeoutMs);
  const type = skill?.executor?.type;
  if (type === "python_stdio") {
    const scriptPath = resolvePathFromProject(skill.projectRoot || process.cwd(), skill?.executor?.script);
    if (!scriptPath) return { ok: false, error: "missing executor.script" };
    const payload = buildSkillPayload(skill, "execute", input);
    return await runPythonJson(scriptPath, payload, effectiveTimeout);
  }
  if (type === "node_module") {
    const payload = buildSkillPayload(skill, "execute", input);
    return await executeNodeModule(skill, payload, "execute");
  }
  return { ok: false, error: `unsupported executor type: ${type || "missing"}` };
}

export function summarizeSkill(skill) {
  return {
    id: skill.id,
    name: skill.name || skill.id,
    description: skill.description || "",
    when_to_use: skill.when_to_use || "",
    action_contract: skill.action_contract || "",
    root: skill.root || "",
    operations: skill.operations,
    examples: skill.examples,
    executor: {
      type: skill?.executor?.type || "unknown",
      contextTimeoutMs: skill?.executor?.contextTimeoutMs,
      executeTimeoutMs: skill?.executor?.executeTimeoutMs,
    },
  };
}
