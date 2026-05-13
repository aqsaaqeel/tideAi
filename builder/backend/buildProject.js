import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

/**
 * LLMs often emit `<script src="main.jsx">`; Vite then treats `main.jsx` as a bare
 * module id and Rollup fails (`failed to resolve import "main.jsx" from "index.html"`).
 * Only rewrite `<script ... src=...>` when the path ends with main.jsx.
 * @param {string} html
 * @returns {string}
 */
function normalizeViteIndexHtml(html) {
  return html.replace(/<script(\s+[^>]*)>/gi, (full, attrs) => {
    const m = /\bsrc\s*=\s*(["'])([^"']*)\1/i.exec(attrs);
    if (!m) return full;
    const q = m[1];
    const raw = String(m[2]).trim();
    if (!/main\.jsx$/i.test(raw)) return full;
    if (raw === "/src/main.jsx" || raw === "./src/main.jsx") return full;
    let next = raw;
    if (raw === "main.jsx" || raw === "./main.jsx" || raw === "/main.jsx") {
      next = "/src/main.jsx";
    } else if (/^src\/main\.jsx$/i.test(raw) && !raw.startsWith("/")) {
      next = `/${raw}`;
    } else {
      return full;
    }
    const newAttrs = attrs.replace(/\bsrc\s*=\s*(["'])([^"']*)\1/i, `src=${q}${next}${q}`);
    return `<script${newAttrs}>`;
  });
}

/**
 * @param {Set<string>} written POSIX paths from project root
 * @param {string} posixPath path without requiring extension
 */
function projectHasSourceFile(written, posixPath) {
  const noExt = posixPath.replace(/\.(jsx?|tsx?)$/, "");
  const candidates = [
    posixPath,
    noExt + ".js",
    noExt + ".jsx",
    noExt + ".ts",
    noExt + ".tsx",
  ];
  return candidates.some((c) => written.has(c));
}

/**
 * Codegen sometimes adds `import … from './utils'` without a `src/utils.js` file.
 * Emit a minimal stub so `vite build` succeeds (preview may need a rebuild for real logic).
 *
 * @param {string} workRoot
 * @param {{ path: string, content: string }[]} files
 */
async function tideaiStubMissingRelativeUtils(workRoot, files) {
  const written = new Set(files.map((f) => f.path.replace(/\\/g, "/")));

  /** @type {Map<string, { names: Set<string>; hasDefault: boolean }>} */
  const stubs = new Map();

  for (const f of files) {
    const rel = f.path.replace(/\\/g, "/");
    if (!rel.startsWith("src/") || !/\.(jsx?|tsx?)$/.test(rel)) continue;
    const source = f.content;

    const addStub = (
      /** @type {string} */ spec,
      /** @type {Set<string>} */ names,
      /** @type {boolean} */ hasDefault
    ) => {
      if (!spec.startsWith(".")) return;
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), spec)
      );
      const base = path.posix.basename(resolved).replace(/\.(jsx?|tsx?)$/, "");
      if (base !== "utils") return;
      if (projectHasSourceFile(written, resolved)) return;
      const canonical = path.posix.join(path.posix.dirname(resolved), "utils");
      if (!stubs.has(canonical))
        stubs.set(canonical, { names: new Set(), hasDefault: false });
      const e = stubs.get(canonical);
      for (const n of names) e.names.add(n);
      if (hasDefault) e.hasDefault = true;
    };

    for (const m of source.matchAll(
      /import\s*\{([\s\S]*?)\}\s*from\s*["'](\.\/utils(?:\.(?:jsx?|tsx?))?)["']/g
    )) {
      const inner = m[1];
      const spec = m[2];
      const names = new Set();
      for (const part of inner.split(",")) {
        const t = part.trim();
        if (!t || /^type\s+/i.test(t)) continue;
        const exported = t.split(/\s+as\s+/)[0].trim();
        if (/^\w+$/.test(exported)) names.add(exported);
      }
      addStub(spec, names, false);
    }
    for (const m of source.matchAll(
      /import\s+(\w+)\s+from\s*["'](\.\/utils(?:\.(?:jsx?|tsx?))?)["']/g
    )) {
      addStub(m[2], new Set(), true);
    }
    if (/\bimport\s*["']\.\/utils["']/.test(source)) {
      addStub("./utils", new Set(), false);
    }
  }

  for (const [canonical, { names, hasDefault }] of stubs) {
    const segments = canonical.split("/");
    const outPath = path.join(workRoot, ...segments) + ".js";
    try {
      await fs.access(outPath);
      continue;
    } catch {
      /* create */
    }
    let body =
      "/* tideAI: stub — an import pointed at ./utils but that file was missing from generated files. */\n";
    if (hasDefault) body += "const _tideaiDefault = {};\nexport default _tideaiDefault;\n";
    for (const n of names)
      body += `export function ${n}() { return undefined; }\n`;
    if (!hasDefault && names.size === 0) body += "export {};\n";
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, body, "utf8");
  }
}

function run(cmd, args, cwd, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ out, err });
      else {
        const combined = err + out;
        const head = combined.slice(0, 1200);
        const tail = combined.slice(-2000);
        reject(
          new Error(
            `${cmd} ${args.join(" ")} exited ${code}\n` +
              (head.trim() ? `--- stderr/stdout (start) ---\n${head}\n` : "") +
              `--- stderr/stdout (end) ---\n${tail}`
          )
        );
      }
    });
  });
}

/**
 * Writes generated files, runs `npm install` + `npm run build` (Vite).
 *
 * `base` controls Vite's [public base path](https://vitejs.dev/config/shared-options.html#base):
 * generated `index.html` references assets at `<base>/assets/...`. Use it for the **local preview**
 * mode so URLs resolve under `/preview/<buildId>/`. Containers/static-host modes can stay on the default `/`.
 *
 * @param {{ path: string, content: string }[]} files
 * @param {Record<string, string>} env
 * @param {string} workRoot absolute path to empty working directory
 * @param {{ base?: string }} [opts]
 * @returns {Promise<string>} absolute path to dist/
 */
export async function buildViteProject(files, env, workRoot, opts = {}) {
  await fs.mkdir(workRoot, { recursive: true });
  for (const f of files) {
    const dest = path.join(workRoot, f.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.content, "utf8");
  }

  const indexPath = path.join(workRoot, "index.html");
  try {
    const before = await fs.readFile(indexPath, "utf8");
    const after = normalizeViteIndexHtml(before);
    if (after !== before) await fs.writeFile(indexPath, after, "utf8");
  } catch {
    /* no index.html at project root */
  }

  await tideaiStubMissingRelativeUtils(workRoot, files);

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const installEnv = {
    ...env,
    NODE_ENV: "development",
    NPM_CONFIG_PRODUCTION: "false",
  };
  await run(
    npm,
    ["install", "--no-audit", "--no-fund", "--include=dev"],
    workRoot,
    installEnv,
    600_000
  );

  /** Forwards extra args to the underlying `vite build` so paths in `index.html` are correct. */
  const buildArgs = ["run", "build"];
  if (opts.base) {
    buildArgs.push("--", `--base=${opts.base}`);
  }
  await run(npm, buildArgs, workRoot, env, 600_000);

  const dist = path.join(workRoot, "dist");
  try {
    await fs.access(dist);
  } catch {
    throw new Error("npm run build did not produce a dist/ folder");
  }
  return dist;
}
