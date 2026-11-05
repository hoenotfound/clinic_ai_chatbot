"use strict";
const { buildSystemPrompt } = require("./systemPrompt");
function buildScopedReplyPrompt(options) {
  return buildSystemPrompt(options);
}
module.exports = { buildScopedReplyPrompt };
