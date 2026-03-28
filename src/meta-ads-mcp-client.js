/**
 * MCP Client for meta-ads-mcp server.
 *
 * Connects via:
 *   - Stdio (default): spawns `uvx meta-ads-mcp` subprocess
 *   - Streamable HTTP: connects to META_ADS_MCP_URL
 *
 * Usage:
 *   import { callTool } from './meta-ads-mcp-client.js';
 *   const result = await callTool('create_campaign', { account_id: 'act_123', ... });
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from './config.js';

let _client = null;
let _transport = null;

async function getClient() {
  if (_client) return _client;

  const mcpUrl = process.env.META_ADS_MCP_URL;

  if (mcpUrl) {
    // Remote streamable-http transport
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    _transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  } else {
    // Local stdio transport (default)
    _transport = new StdioClientTransport({
      command: process.env.META_ADS_MCP_COMMAND || 'uvx',
      args: (process.env.META_ADS_MCP_ARGS || 'meta-ads-mcp').split(' '),
      env: {
        ...process.env,
        META_ACCESS_TOKEN: config.meta?.accessToken || '',
      },
    });
  }

  _client = new Client({ name: 'lead-engine', version: '1.0.0' });
  await _client.connect(_transport);
  return _client;
}

/**
 * Call a meta-ads-mcp tool and return the parsed JSON response.
 * @param {string} name - Tool name (e.g. 'create_campaign')
 * @param {Object} args - Tool arguments
 * @returns {Promise<Object>} Parsed response from Meta API
 */
export async function callTool(name, args = {}) {
  const client = await getClient();

  // For remote HTTP transport, inject access_token per-call
  const callArgs = { ...args };
  if (process.env.META_ADS_MCP_URL && !callArgs.access_token) {
    callArgs.access_token = config.meta?.accessToken;
  }

  const result = await client.callTool({ name, arguments: callArgs });

  if (result.isError) {
    const errorText =
      result.content?.find((b) => b.type === 'text')?.text ||
      'MCP tool call failed';
    throw new Error(`Meta MCP [${name}]: ${errorText}`);
  }

  const textBlock = result.content?.find((b) => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error(`Meta MCP [${name}] returned no content`);
  }

  try {
    return JSON.parse(textBlock.text);
  } catch {
    // Some tools return plain text
    return { text: textBlock.text };
  }
}

/**
 * List available tools from the MCP server.
 * Returns tool definitions in MCP format: { name, description, inputSchema }.
 * @returns {Promise<Array>}
 */
export async function listTools() {
  const client = await getClient();
  const result = await client.listTools();
  return result.tools || [];
}

/**
 * Gracefully close the MCP client connection.
 */
export async function closeMcpClient() {
  if (_client) {
    await _client.close().catch(() => {});
    _client = null;
  }
  if (_transport) {
    await _transport.close().catch(() => {});
    _transport = null;
  }
}
