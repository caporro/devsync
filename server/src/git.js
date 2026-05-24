import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

import { vaultDir } from "./storage.js"
import { appendSystemLogEvent } from "./system-log.js"

const GIT_TIMEOUT_MS = Number(process.env.DEVSYNC_GIT_TIMEOUT_MS ?? 120000)
const GIT_MAX_BUFFER = Number(process.env.DEVSYNC_GIT_MAX_BUFFER ?? 1024 * 1024)
const VAULT_REPO_URL = String(process.env.DEVSYNC_VAULT_REPO_URL ?? "").trim()
const GIT_USERNAME = String(process.env.DEVSYNC_GIT_USERNAME ?? "oauth2").trim()
const GIT_TOKEN = String(process.env.DEVSYNC_GIT_TOKEN ?? "").trim()
const GIT_COMMIT_NAME = String(process.env.DEVSYNC_GIT_COMMIT_NAME ?? "Devsync").trim()
const GIT_COMMIT_EMAIL = String(process.env.DEVSYNC_GIT_COMMIT_EMAIL ?? "devsync@example.invalid").trim()

function quoteArg(arg) {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg
}

function redactSecrets(value) {
  let output = String(value ?? "")

  if (GIT_TOKEN) {
    output = output.replaceAll(GIT_TOKEN, "***")
  }

  return output.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/g, "$1***:***@")
}

function commandLabel(args) {
  return `git ${args.map((arg) => quoteArg(redactSecrets(arg))).join(" ")}`
}

function gitEnv() {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: GIT_COMMIT_NAME,
    GIT_AUTHOR_EMAIL: GIT_COMMIT_EMAIL,
    GIT_COMMITTER_NAME: GIT_COMMIT_NAME,
    GIT_COMMITTER_EMAIL: GIT_COMMIT_EMAIL,
    GIT_TERMINAL_PROMPT: "0",
  }

  if (GIT_TOKEN) {
    env.GIT_CONFIG_COUNT = "1"
    env.GIT_CONFIG_KEY_0 = "http.extraHeader"
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${GIT_USERNAME}:${GIT_TOKEN}`).toString("base64")}`
  }

  return env
}

function localStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0")

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function runGit(args, cwd = process.cwd(), successCodes = [0]) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: gitEnv(),
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0

        resolve({
          command: commandLabel(args),
          ok: successCodes.includes(code),
          code,
          stdout: redactSecrets(stdout),
          stderr: redactSecrets(stderr ?? error?.message ?? ""),
        })
      }
    )
  })
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch (error) {
    if (error.code === "ENOENT") {
      return false
    }

    throw error
  }
}

async function isEmptyDir(target) {
  try {
    return (await fs.readdir(target)).length === 0
  } catch (error) {
    if (error.code === "ENOENT") {
      return true
    }

    throw error
  }
}

async function ensureOriginRemote(repoUrl) {
  const current = await runGit(["remote", "get-url", "origin"], vaultDir, [0, 2])

  if (current.ok && current.code === 0) {
    if (current.stdout.trim() === repoUrl) {
      return current
    }

    return runGit(["remote", "set-url", "origin", repoUrl], vaultDir)
  }

  return runGit(["remote", "add", "origin", repoUrl], vaultDir)
}

async function resolveGitRoot() {
  const step = await runGit(["rev-parse", "--show-toplevel"], vaultDir)

  if (!step.ok) {
    return {
      ok: false,
      summary: "Not a Git repository.",
      steps: [step],
    }
  }

  return {
    ok: true,
    root: step.stdout.trim(),
    steps: [step],
  }
}

function vaultPathspec(gitRoot) {
  const relative = path.relative(gitRoot, vaultDir).split(path.sep).join("/")

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return relative === "" ? "." : null
  }

  return relative
}

export async function gitPull() {
  const rootResult = await resolveGitRoot()

  if (!rootResult.ok) {
    return {
      action: "pull",
      ok: false,
      summary: rootResult.summary,
      steps: rootResult.steps,
    }
  }

  const pull = await runGit(["pull", "--ff-only"], rootResult.root)
  await appendSystemLogEvent({
    action: "git.pull",
    source: "git",
    actor: "server",
    target: vaultDir,
    summary: pull.ok ? "Git pull completed" : "Git pull failed",
    metadata: { ok: pull.ok, code: pull.code },
  })

  return {
    action: "pull",
    ok: pull.ok,
    summary: pull.ok ? "Pull completed." : "Pull failed.",
    steps: [...rootResult.steps, pull],
  }
}

export async function ensureVaultGit() {
  if (!VAULT_REPO_URL) {
    return {
      action: "bootstrap",
      ok: true,
      summary: "No vault repository configured.",
      steps: [],
    }
  }

  const hasGit = await pathExists(path.join(vaultDir, ".git"))

  if (!hasGit) {
    const vaultIsEmpty = await isEmptyDir(vaultDir)

    if (!vaultIsEmpty) {
      return {
        action: "bootstrap",
        ok: true,
        summary: "Vault folder is not a Git repository. Git sync disabled.",
        steps: [],
      }
    }

    await fs.mkdir(path.dirname(vaultDir), { recursive: true })
    const clone = await runGit(["clone", VAULT_REPO_URL, vaultDir], path.dirname(vaultDir))

    return {
      action: "bootstrap",
      ok: true,
      summary: clone.ok ? "Vault cloned." : "Vault clone failed. Using local vault.",
      steps: [clone],
    }
  }

  const remote = await ensureOriginRemote(VAULT_REPO_URL)
  const pull = await gitPull()

  return {
    action: "bootstrap",
    ok: remote.ok && pull.ok,
    summary: remote.ok && pull.ok ? "Vault repository ready." : "Vault repository bootstrap failed.",
    steps: [remote, ...pull.steps],
  }
}

export async function gitPush() {
  const rootResult = await resolveGitRoot()

  if (!rootResult.ok) {
    return {
      action: "push",
      ok: false,
      summary: rootResult.summary,
      steps: rootResult.steps,
    }
  }

  const pathspec = vaultPathspec(rootResult.root)

  if (!pathspec) {
    return {
      action: "push",
      ok: false,
      summary: "Vault data is outside the Git repository.",
      steps: rootResult.steps,
    }
  }

  const steps = [...rootResult.steps]
  const add = await runGit(["add", "--", pathspec], rootResult.root)
  steps.push(add)

  if (!add.ok) {
    return {
      action: "push",
      ok: false,
      summary: "Git add failed.",
      steps,
    }
  }

  const diff = await runGit(["diff", "--cached", "--quiet", "--", pathspec], rootResult.root, [0, 1])
  steps.push(diff)

  if (!diff.ok) {
    return {
      action: "push",
      ok: false,
      summary: "Git diff failed.",
      steps,
    }
  }

  let committed = false

  if (diff.code === 1) {
    const commit = await runGit(["commit", "-m", `devsync ${localStamp()}`, "--", pathspec], rootResult.root)
    steps.push(commit)

    if (!commit.ok) {
      return {
        action: "push",
        ok: false,
        summary: "Git commit failed.",
        steps,
      }
    }

    committed = true
  }

  const push = await runGit(["push"], rootResult.root)
  steps.push(push)
  await appendSystemLogEvent({
    action: "git.push",
    source: "git",
    actor: "server",
    target: vaultDir,
    summary: push.ok ? "Git push completed" : "Git push failed",
    metadata: { ok: push.ok, code: push.code, committed },
  })

  return {
    action: "push",
    ok: push.ok,
    summary: push.ok
      ? committed
        ? "Commit and push completed."
        : "No local data changes. Push executed."
      : "Push failed.",
    steps,
  }
}
