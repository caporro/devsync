import { stdin as input, stdout as output } from "node:process"
import { createPasswordHash } from "../server/src/auth.js"

function promptHidden(prompt) {
  return new Promise((resolve, reject) => {
    let password = ""

    output.write(prompt)
    input.setRawMode(true)
    input.resume()
    input.setEncoding("utf8")

    function cleanup() {
      input.setRawMode(false)
      input.off("data", onData)
      output.write("\n")
    }

    function onData(char) {
      if (char === "\u0003") {
        cleanup()
        reject(new Error("Cancelled"))
        return
      }

      if (char === "\r" || char === "\n") {
        cleanup()
        resolve(password)
        return
      }

      if (char === "\u007f") {
        password = password.slice(0, -1)
        return
      }

      password += char
    }

    input.on("data", onData)
  })
}

async function readStdin() {
  let value = ""

  for await (const chunk of input) {
    value += chunk
  }

  return value.trimEnd()
}

async function readPassword() {
  const cliPassword = process.argv[2] ?? process.env.DEVSYNC_PASSWORD

  if (cliPassword) {
    return cliPassword
  }

  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return readStdin()
  }

  return promptHidden("Password: ")
}

const password = await readPassword()

if (!password) {
  console.error("Password is required")
  process.exit(1)
}

console.log(await createPasswordHash(password))
