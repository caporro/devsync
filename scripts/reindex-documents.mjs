import { documentIndex, ensureDataDir } from "../server/src/storage.js"

try {
  await ensureDataDir()
  await documentIndex.rebuild()
  console.log("Document index rebuilt from the vault files.")
} finally {
  await documentIndex.close()
}
