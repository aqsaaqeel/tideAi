import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {number} timeoutMs
 */
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
