/** MCP adapter unit tests — catalogue shape and error contract. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_TOOLS } from "../server/adapters/mcp.ts";

test("mcp catalogue: every tool has name, description and object schema", () => {
  assert.ok(MCP_TOOLS.length >= 8);
  for (const tool of MCP_TOOLS) {
    assert.ok(tool.name, "name present");
    assert.ok(tool.description.length > 10, `description for ${tool.name}`);
    assert.equal(tool.inputSchema.type, "object");
  }
  const names = MCP_TOOLS.map((t) => t.name);
  assert.deepEqual([...new Set(names)], names, "tool names unique");
});

test("mcp catalogue: required fields exist in properties", () => {
  for (const tool of MCP_TOOLS) {
    for (const required of tool.inputSchema.required ?? []) {
      assert.ok(tool.inputSchema.properties[required], `${tool.name}: required "${required}" documented`);
    }
  }
});
