import fs from "node:fs/promises";
import path from "node:path";

/**
 * Resolve a target path safely within a root directory.
 * Prevents path traversal outside the allowed root.
 */
function safeResolve(root, relPath) {
  const resolved = path.resolve(root, relPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path escapes root: ${relPath}`);
  }
  return resolved;
}

const ALLOWED_EXTENSIONS = new Set([".md", ".txt"]);

export async function getContext(payload) {
  const memoryRoot = payload?.memory_root || payload?.skill_root || "";
  if (!memoryRoot) {
    return { ok: false, error: "memory_root not provided" };
  }

  const folders = ["notes", "knowledge"];
  const catalog = {};

  for (const folder of folders) {
    const dir = path.join(memoryRoot, folder);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      catalog[folder] = entries
        .filter((e) => e.isFile() && e.name !== ".gitkeep")
        .map((e) => e.name);
    } catch {
      catalog[folder] = [];
    }
  }

  return {
    ok: true,
    context_type: "memory-writer",
    memory_root: memoryRoot,
    catalog,
  };
}

export async function execute(payload) {
  const action =
    payload?.action && typeof payload.action === "object" ? payload.action : {};
  const memoryRoot = payload?.memory_root || payload?.skill_root || "";

  if (!memoryRoot) {
    return { ok: false, error: "memory_root not provided" };
  }

  const operation = String(action.operation || "write").trim().toLowerCase();
  const folder = String(action.folder || "notes").trim().toLowerCase();
  const filename = String(action.filename || "").trim();
  const content = String(action.content || "").trim();

  if (!["notes", "knowledge"].includes(folder)) {
    return { ok: false, error: `Invalid folder: ${folder}. Must be "notes" or "knowledge".` };
  }

  const targetDir = path.join(memoryRoot, folder);

  // --- list operation ---
  if (operation === "list") {
    try {
      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && e.name !== ".gitkeep")
        .map((e) => e.name);
      return {
        ok: true,
        operation: "list",
        folder,
        files,
        count: files.length,
        result: files.length
          ? `${folder}/ contains ${files.length} file(s): ${files.join(", ")}`
          : `${folder}/ is empty.`,
      };
    } catch {
      return { ok: true, operation: "list", folder, files: [], count: 0, result: `${folder}/ is empty.` };
    }
  }

  // --- write / append operations ---
  if (!filename) {
    return { ok: false, error: "filename is required for write/append operations." };
  }

  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      error: `Invalid extension "${ext}". Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`,
    };
  }

  if (!content) {
    return { ok: false, error: "content is required for write/append operations." };
  }

  let targetPath;
  try {
    targetPath = safeResolve(targetDir, filename);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Ensure directory exists
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  if (operation === "append") {
    const separator = "\n\n---\n\n";
    let existing = "";
    try {
      existing = await fs.readFile(targetPath, "utf8");
    } catch {
      // File doesn't exist yet — that's fine, append creates it
    }
    const newContent = existing ? existing.trimEnd() + separator + content + "\n" : content + "\n";
    await fs.writeFile(targetPath, newContent, "utf8");
    return {
      ok: true,
      operation: "append",
      folder,
      filename,
      path: `${folder}/${filename}`,
      result: `Appended to ${folder}/${filename}.`,
    };
  }

  // Default: write (create / overwrite)
  await fs.writeFile(targetPath, content + "\n", "utf8");
  return {
    ok: true,
    operation: "write",
    folder,
    filename,
    path: `${folder}/${filename}`,
    result: `Saved to ${folder}/${filename}.`,
  };
}
