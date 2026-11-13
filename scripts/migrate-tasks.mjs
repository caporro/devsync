import fs from "node:fs/promises"
import { dataDir, vaultDir, documentIndex, ensureDataDir, listTasks } from "../server/src/storage.js"

try {
  await ensureDataDir()
  const projects = (await fs.readdir(dataDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name))
  let total = 0
  for (const project of projects) {
    const tasks = await listTasks(project.name)
    total += tasks.length
    console.log(`${project.name}: ${tasks.length} task(s) migrated/verified`)
  }
  console.log(`Verified ${total} task(s) in ${vaultDir}. Originals, when migrated, are kept in tasks/.migration-v2/.`)
} finally {
  await documentIndex.close()
}
