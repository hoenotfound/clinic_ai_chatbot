/**
 * Picks which AI backend to use, based on AI_PROVIDER in .env.
 * Both claudeService and geminiService expose the same getReply(messages, isFirstMessage) shape,
 * so switching providers is just changing this one env var — no other code needs to change.
 */

const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();

let impl;
if (provider === "claude") {
  impl = require("./claudeService");
} else if (provider === "gemini") {
  impl = require("./geminiService");
} else {
  throw new Error(
    `Unknown AI_PROVIDER "${provider}" — use "claude" or "gemini" in your .env`
  );
}

console.log(`AI provider: ${provider}`);

module.exports = { getReply: impl.getReply };
