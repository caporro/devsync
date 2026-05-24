import { spawn } from "node:child_process"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const startPort = Number(process.env.DEVSYNC_WEB_PORT ?? 5173)
const host = "127.0.0.1"

function canBindIpv4(port) {
  return new Promise((resolve) => {
    const server = net.createServer()

    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen({ host: "0.0.0.0", port })
  })
}

async function findPort() {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await canBindIpv4(port)) {
      return port
    }
  }

  throw new Error(`No free IPv4 port found from ${startPort} to ${startPort + 99}`)
}

const port = await findPort()
const viteBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite")
const child = spawn(viteBin, ["--host", host, "--port", String(port)], {
  cwd: root,
  stdio: "inherit",
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal)
  })
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 0)
})
