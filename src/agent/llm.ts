import { requestUrl } from "obsidian";
import type { MorningOSSettings } from "../settings";

interface OpenAIResponse {
  choices: { message: { content: string } }[];
}

interface GeminiResponse {
  candidates: { content: { parts: { text: string }[] } }[];
}

interface BedrockResponse {
  output: { message: { content: { text: string }[] } };
}

async function callOpenAI(system: string, user: string, apiKey: string, model: string): Promise<string> {
  const response = await requestUrl({
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });
  return (response.json as OpenAIResponse).choices[0].message.content;
}

async function callGroq(system: string, user: string, apiKey: string, model: string): Promise<string> {
  const response = await requestUrl({
    url: "https://api.groq.com/openai/v1/chat/completions",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });
  return (response.json as OpenAIResponse).choices[0].message.content;
}

async function callGemini(system: string, user: string, apiKey: string, model: string): Promise<string> {
  const response = await requestUrl({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: user }] }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    }),
  });
  return (response.json as GeminiResponse).candidates[0].content.parts[0].text;
}

async function hmacSha256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function signAwsRequest(opts: {
  method: string;
  host: string;
  path: string;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Promise<Record<string, string>> {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, "").slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;

  const payloadHash = await sha256Hex(opts.body);
  const canonicalHeaders = `content-type:application/json\nhost:${opts.host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = [
    opts.method, opts.path, "", canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmacSha256(new TextEncoder().encode("AWS4" + opts.secretAccessKey).buffer as ArrayBuffer, dateStamp);
  const kRegion = await hmacSha256(kDate, opts.region);
  const kService = await hmacSha256(kRegion, opts.service);
  const kSigning = await hmacSha256(kService, "aws4_request");

  const signatureBytes = await hmacSha256(kSigning, stringToSign);
  const signature = Array.from(new Uint8Array(signatureBytes)).map(b => b.toString(16).padStart(2, "0")).join("");

  return {
    "x-amz-date": amzDate,
    "Authorization": `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function callBedrock(system: string, user: string, settings: MorningOSSettings): Promise<string> {
  const region = settings.awsRegion || settings.intelligenceRegion || "us-east-2";
  const model = settings.intelligenceModel;
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(model)}/converse`;

  const body = JSON.stringify({
    messages: [{ role: "user", content: [{ text: user }] }],
    system: [{ text: system }],
    inferenceConfig: { maxTokens: 2048, temperature: 0.7 },
  });

  const headers = await signAwsRequest({
    method: "POST",
    host,
    path,
    body,
    region,
    service: "bedrock",
    accessKeyId: settings.awsAccessKeyId,
    secretAccessKey: settings.awsSecretAccessKey,
  });

  const response = await requestUrl({
    url: `https://${host}${path}`,
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body,
  });

  return (response.json as BedrockResponse).output.message.content[0].text;
}

export async function callLLM(system: string, user: string, settings: MorningOSSettings): Promise<string> {
  const provider = settings.intelligenceProvider;
  switch (provider) {
    case "openai":  return callOpenAI(system, user, settings.openaiApiKey, settings.intelligenceModel);
    case "groq":    return callGroq(system, user, settings.groqApiKey, settings.intelligenceModel);
    case "gemini":  return callGemini(system, user, settings.geminiApiKey, settings.intelligenceModel);
    case "bedrock": return callBedrock(system, user, settings);
    default:        throw new Error(`Unsupported provider: ${provider}`);
  }
}
