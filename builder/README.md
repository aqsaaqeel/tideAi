# tideAI

tideAI is a small “Lovable-style” builder aimed at AI startups on DigitalOcean. You type a one-line product idea and paste your **DigitalOcean** API token. By default the service **does not use GitHub**:

1. Calls **DigitalOcean Serverless Inference** to emit a full **React + Vite** project as JSON  
2. Parses that into files  
3. Writes them to a temp folder, runs **`npm install` + `npm run build`**, and serves the built **`dist/`** from a tiny **busybox `httpd`** layer  
4. Pushes that image to **DigitalOcean Container Registry (DOCR)** using the Registry HTTP API (no Docker daemon)  
5. Creates an **App Platform** app from that **DOCR** image and polls until a **live URL** is returned  

The UI is a minimal React + Vite single page that talks to a Node + Express backend.

## Prerequisites (default DOCR path)

- Node.js 18+ (uses global `fetch`)  
- **[Container Registry](https://docs.digitalocean.com/products/container-registry/)** — if your account has none yet, tideAI will try to **create** one automatically ( **`subscription_tier_slug`: `starter`** by default). Your API token must allow **`registry:create`** for that to succeed. Set **`TIDEAI_AUTO_CREATE_REGISTRY=false`** to skip auto-create and get a clear manual error instead. Override tier with **`DO_REGISTRY_SUBSCRIPTION_TIER`** (`starter`, `basic`, or `professional`). Optional **`DO_REGISTRY_REGION`** (e.g. `nyc3`, `sfo3`).  
- **Starter registry = one repository:** if your registry already has a repository (any name), tideAI **reuses that repository** and pushes a **new tag** per build. To force a name, set **`TIDEAI_DOCR_REPO_NAME`** on the server (must match your existing repo slug on Starter, or upgrade the registry tier for more repositories).  
- A **DigitalOcean personal access token** with permission to use **Serverless Inference**, **App Platform** (create apps), and **Container Registry** (read + write / docker-credentials). During testing, a broad **read + write** token is simplest.  
- The machine running the tideAI backend must have a **`tar`** binary on `PATH` (included in `node:*-alpine` Docker images).  
- Outbound HTTPS to **`busybox.net`** (static busybox binary) unless you override **`TIDEAI_BUSYBOX_URL`** in the environment.

## Optional: GitHub deploy mode

To use the older flow (create GitHub repo + push files + App Platform static site from Git), call **`POST /api/build`** with **`"deploy_mode": "github"`** and configure **`GITHUB_TOKEN`** on the server (or pass **`github_token`** in the body). Linking GitHub in the App Platform UI only helps DO **clone** repos; it does not replace GitHub credentials for **creating** repos and **pushing** files via the GitHub API.

## DigitalOcean API token

Create a personal access token with the scopes you need for **Inference**, **Apps**, and **Registry**.  
Official guide: [How to Create a Personal Access Token](https://docs.digitalocean.com/reference/api/create-personal-access-token/)

Codegen calls **`llama3.3-70b-instruct`** by default (see [available models](https://docs.digitalocean.com/products/inference/details/models/)). Older IDs such as `meta-llama/Meta-Llama-3.1-70B-Instruct` return **404 model not found**. Override with **`INFERENCE_MODEL`** in the environment if you prefer another chat model ID.

## Run locally

1. Ensure **Container Registry** exists on your DO account.

2. Optional env file for the backend (see `builder/.env.example`). For the frontend, create `builder/frontend/.env`:

   ```bash
   VITE_API_URL=http://localhost:3001
   ```

3. Install and start the **backend**:

   ```bash
   cd builder/backend
   npm install
   npm run dev
   ```

4. In another terminal, install and start the **frontend**:

   ```bash
   cd builder/frontend
   npm install
   npm run dev
   ```

5. Open the Vite URL (usually `http://localhost:5173`), enter your prompt and DO token, and submit.

The backend listens on `PORT` (default **3001**). Health check: `GET http://localhost:3001/health`.

## Deploy tideAI on DigitalOcean App Platform

The repo includes a **single Docker service** under `builder/` that builds the Vite UI, copies `dist` into `backend/public`, and runs Express on **`PORT`**. The browser uses the **same origin** for `/api/...`, so you do not set `VITE_API_URL` in production.

1. Push this repository to GitHub (root contains `.do/` and `builder/`).  
2. Edit `.do/app.yaml` and set `services[0].github.repo` to your repo (`owner/name`).  
3. Create the app from the spec (or add a Dockerfile service: **source dir** `builder`, **Dockerfile** `Dockerfile`, **HTTP port** `8080`, **health** `/health`).  
4. **No `GITHUB_TOKEN` is required** on the tideAI app for the default DOCR pipeline. Child builds use the **end user’s** `do_token` from the form.  
5. Redeploy and open the live URL.

Local image smoke test:

```bash
docker build -t tideai ./builder
docker run --rm -p 8080:8080 -e PORT=8080 tideai
# Visit http://localhost:8080/health and http://localhost:8080/
```

## Troubleshooting

**The form still shows a GitHub token field.** The UI you see on port **8080** comes from the **frontend bundle that was baked in when the Docker image was built**. After pulling new code, rebuild the image so the `frontend-build` stage runs again, for example:

```bash
docker build --no-cache -t tideai ./builder
docker run --rm -p 8080:8080 -e PORT=8080 tideai
```

Then do a hard refresh in the browser (**Cmd+Shift+R** / **Ctrl+Shift+R**). The current source form only asks for a prompt and a DigitalOcean token.

**`model not found` (404) from Inference.** DigitalOcean model IDs change over time. This repo defaults to **`llama3.3-70b-instruct`**. Set **`INFERENCE_MODEL`** to another ID from the [model catalog](https://docs.digitalocean.com/products/inference/details/models/) if your account or region does not expose that model.

**`vite: not found` during the Vite build step.** The tideAI server often runs with **`NODE_ENV=production`** (for example in Docker). Plain `npm install` then skips **devDependencies**, but generated apps keep **Vite** there. The backend now runs install with dev deps included; rebuild your tideAI image after pulling the fix.

## Security note

Each build sends the user’s **DigitalOcean** token to your backend for Inference, Registry, and App creation. Do not expose tideAI to the public internet without authentication and rate limits. If you enable **GitHub** mode, treat **`GITHUB_TOKEN`** as a highly sensitive secret (App Platform encrypted env, never commit).
