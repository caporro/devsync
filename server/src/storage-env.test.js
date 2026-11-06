import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const run = promisify(execFile)
const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-storage-env-"))
after(() => fs.rm(root, { recursive: true, force: true }))

for (const [label, value] of [["unset", undefined], ["empty", ""], ["whitespace", "   "], ["explicit legacy", path.join(root, "legacy", "projects")]]) {
  test(`${label} legacy data directory initializes the correct vault`, async () => {
    const env = {
      ...process.env,
      NODE_ENV: "test",
      DEVSYNC_DATA_ROOT: root,
      DEVSYNC_VAULT_NAME: `env-${label.replaceAll(" ", "-")}`,
    }
    if (value === undefined) delete env.DEVSYNC_DATA_DIR
    else env.DEVSYNC_DATA_DIR = value
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
      import { dataDir, vaultDir, ensureDataDir } from './storage.js';
      await ensureDataDir();
      console.log(JSON.stringify({ dataDir, vaultDir }));
    `], { cwd: path.dirname(fileURLToPath(import.meta.url)), env })
    const actual = JSON.parse(stdout)
    const expectedVault = value?.trim() ? path.dirname(value) : path.join(root, env.DEVSYNC_VAULT_NAME)
    assert.equal(actual.vaultDir, expectedVault)
    assert.equal(actual.dataDir, path.join(expectedVault, "projects"))
    assert.equal((await fs.stat(actual.dataDir)).isDirectory(), true)
  })
}
