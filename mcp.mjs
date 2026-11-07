// Compatibility entry point: existing MCP registrations point at mcp.mjs.
// The implementation lives in mcp.mts (run directly by Node's type stripping, Node >= 22.18).
import './mcp.mts';
