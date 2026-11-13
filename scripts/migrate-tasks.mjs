import fs from "node:fs/promises"
import { dataDir, vaultDir, documentIndex, ensureDataDir, listTasks, repairTaskFileNames } from "../server/src/storage.js"

try {
  const args = new Set(process.argv.slice(2))
  if ([...args].some((arg) => !["--repair-filenames", "--dry-run"].includes(arg)) || (args.has("--dry-run") && !args.has("--repair-filenames"))) {
    throw new Error("Usage: npm run migrate:tasks -- [--repair-filenames [--dry-run]]")
  }
  const dryRun = args.has("--dry-run")
  if (!dryRun) await ensureDataDir()
  const projects = (await fs.readdir(dataDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name))
  let total = 0
  let repaired = 0
  for (const project of projects) {
    if (args.has("--repair-filenames")) {
      const result = await repairTaskFileNames(project.name, { dryRun })
      repaired += result.repairs.length
      for (const { from, to } of result.repairs) console.log(`${project.name}: ${dryRun ? "would repair" : "repaired"} ${from} -> ${to}`)
      for (const { path, reason } of result.skipped) console.error(`${project.name}: skipped ${path}: ${reason}`)
      if (result.skipped.length) process.exitCode = 1
    }
    if (dryRun) continue
    const tasks = await listTasks(project.name)
    total += tasks.length
    console.log(`${project.name}: ${tasks.length} task(s) migrated/verified`)
  }
  if (args.has("--repair-filenames")) console.log(`${dryRun ? "Would repair" : "Repaired"} ${repaired} task filename(s). Repair originals are kept in tasks/.filename-repair/.`)
  if (!dryRun) console.log(`Verified ${total} task(s) in ${vaultDir}. Originals, when migrated, are kept in tasks/.migration-v2/.`)
} finally {
  await documentIndex.close()
}
