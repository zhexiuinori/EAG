// 最小 MCP server（stdio + JSON-RPC 2.0），仅用于验证 EAG 的 MCP 集成链路。
// 提供两个工具：echo（回显）、read_local（读取给定路径，用于验证策略拦截）。

const TOOLS = [
  {
    name: "echo",
    description: "回显输入文本",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "read_local",
    description: "读取本地文件（路径参数会被 EAG 策略检查）",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

let buffer = "";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-mcp", version: "1.0.0" } } });
  }
  if (method === "notifications/initialized") return; // 通知，无响应
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    const { name, arguments: args } = params ?? {};
    if (name === "echo") {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo: ${args?.text ?? ""}` }] } });
    }
    if (name === "read_local") {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `read ${args?.path}` }] } });
    }
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `未知工具 ${name}` } });
  }
  if (id !== undefined) {
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `不支持的方法 ${method}` } });
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // 忽略坏帧
    }
  }
});
