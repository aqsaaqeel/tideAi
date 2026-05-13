const GITHUB_API = "https://api.github.com";

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function randomSuffix() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/**
 * @param {string} githubToken
 * @param {string} appName
 * @returns {Promise<{ repoFullName: string, repoUrl: string }>}
 */
export async function createRepo(githubToken, appName) {
  const tryCreate = async (name) => {
    const res = await fetch(`${GITHUB_API}/user/repos`, {
      method: "POST",
      headers: githubHeaders(githubToken),
      body: JSON.stringify({
        name,
        private: false,
        auto_init: false,
      }),
    });

    const bodyText = await res.text();
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const err = new Error(
        json?.message || bodyText || `GitHub create repo failed: ${res.status}`
      );
      err.status = res.status;
      err.body = bodyText;
      throw err;
    }

    const full = json.full_name;
    const html = json.html_url;
    if (!full || !html) {
      throw new Error("GitHub create repo response missing full_name or html_url");
    }
    return { repoFullName: full, repoUrl: html };
  };

  try {
    return await tryCreate(appName);
  } catch (e) {
    const msg = (e.message || "").toLowerCase();
    const exists =
      e.status === 422 &&
      (msg.includes("already exists") || msg.includes("name already"));
    if (exists) {
      return await tryCreate(`${appName}-${randomSuffix()}`);
    }
    throw e;
  }
}

/**
 * @param {string} githubToken
 * @param {string} repoFullName owner/repo
 * @param {{ path: string, content: string }[]} files
 */
export async function pushFiles(githubToken, repoFullName, files) {
  for (const file of files) {
    const path = file.path.split("/").map(encodeURIComponent).join("/");
    const url = `${GITHUB_API}/repos/${repoFullName}/contents/${path}`;

    const res = await fetch(url, {
      method: "PUT",
      headers: githubHeaders(githubToken),
      body: JSON.stringify({
        message: "Initial commit",
        content: Buffer.from(file.content, "utf8").toString("base64"),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GitHub push failed for ${file.path}: ${res.status} ${text.slice(0, 400)}`
      );
    }
  }
}
