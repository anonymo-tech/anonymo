// bun examples/generate.ts  (needs ANONYMO_API_KEY)
import { embed, generateText, streamText } from "ai";
import { anonymo, createAnonymo } from "../src/index.ts";

const { text, providerMetadata } = await generateText({
  model: anonymo("meta-llama/llama-3.3-70b-instruct"),
  prompt: "Say hello in five words.",
});
console.log(text, providerMetadata?.anonymo); // { receiptId, receiptKeyId, costUsd }

// Attested lane: only providers with a verified enclave, or a refusal with nothing sent.
const attested = createAnonymo({ lane: "attested" });
const stream = streamText({ model: attested("z-ai/glm-5.3"), prompt: "One fact about enclaves." });
for await (const part of stream.textStream) process.stdout.write(part);
console.log("\n", await stream.providerMetadata);

const { embedding } = await embed({ model: anonymo.embeddingModel("qwen/qwen3-embedding-8b"), value: "any route" });
console.log(embedding.length);
