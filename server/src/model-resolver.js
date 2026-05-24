import { ChatBedrockConverse } from "@langchain/aws"
import { ChatOpenAI } from "@langchain/openai"
import { initChatModel } from "langchain/chat_models/universal"

function envFirst(names) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) {
      return value
    }
  }

  return ""
}

function parseModelString(modelString) {
  const [provider, ...modelParts] = String(modelString).split(":")
  const model = modelParts.join(":")

  if (!provider || !model) {
    throw new Error(`Invalid model string "${modelString}". Expected provider:model.`)
  }

  return {
    provider,
    model,
  }
}

function resolveBedrockConverse(model) {
  const region = envFirst(["BEDROCK_AWS_REGION", "AWS_REGION", "AWS_DEFAULT_REGION"])
  const applicationInferenceProfile = envFirst([
    "DEVSYNC_BEDROCK_APPLICATION_INFERENCE_PROFILE",
    "BEDROCK_APPLICATION_INFERENCE_PROFILE",
  ])

  if (!region) {
    throw new Error("BEDROCK_AWS_REGION, AWS_REGION or AWS_DEFAULT_REGION is required for bedrock_converse models.")
  }

  return new ChatBedrockConverse({
    model,
    region,
    ...(applicationInferenceProfile ? { applicationInferenceProfile } : {}),
  })
}

function resolveOpenAi(model) {
  const apiKey = envFirst(["OPENAI_API_KEY"])
  const baseURL = envFirst(["OPENAI_BASE_URL", "OPENAI_API_BASE_URL", "OPENAI_API_BASE"])

  return new ChatOpenAI({
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { configuration: { baseURL } } : {}),
  })
}

export async function resolveChatModel(modelString) {
  const { provider, model } = parseModelString(modelString)

  if (["bedrock", "bedrock_converse"].includes(provider)) {
    return resolveBedrockConverse(model)
  }

  if (["openai", "openai-compatible"].includes(provider)) {
    return resolveOpenAi(model)
  }

  return initChatModel(model, {
    modelProvider: provider,
  })
}
