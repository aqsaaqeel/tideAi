/**
 * Extract outermost balanced `{ ... }` from a string (handles nested objects).
 * @param {string} str
 * @returns {string | null}
 */
function extractOutermostJsonObject(str) {
  const start = str.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  let quote = "";

  for (let i = start; i < str.length; i++) {
    const c = str[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      continue;
    }

    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * @param {string} raw
 * @returns {object} Parsed project spec with app_name, files, etc.
 */
export function parseCodegenOutput(raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    const block = extractOutermostJsonObject(raw);
    if (!block) {
      throw new Error("Could not parse LLM output as JSON");
    }
    try {
      parsed = JSON.parse(block);
    } catch {
      throw new Error("Could not parse LLM output as JSON");
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Could not parse LLM output as JSON");
  }

  if (typeof parsed.app_name !== "string" || !parsed.app_name.trim()) {
    throw new Error("Parsed JSON missing valid app_name");
  }

  if (!Array.isArray(parsed.files) || parsed.files.length < 3) {
    throw new Error("Parsed JSON must include a files array with at least 3 files");
  }

  for (const f of parsed.files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
      throw new Error("Each file must have path and content strings");
    }
    // Paths like `.do/app.yaml` imply a `.do/` directory; the GitHub Contents API creates parent paths automatically.
  }

  return parsed;
}
