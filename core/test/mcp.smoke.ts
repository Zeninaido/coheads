// Starts src/mcp.ts over stdio with the official client, the way Claude Desktop does.
//   bun run test/mcp.smoke.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';

const transport = new StdioClientTransport({
  command: process.execPath, // bun
  args: ['run', join(import.meta.dir, '..', 'src', 'mcp.ts')],
  env: { ...process.env, SB_USER: 'suzuki' } as Record<string, string>,
});
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

console.log('instructions:', client.getInstructions()?.split('\n')[1]);
const tools = (await client.listTools()).tools;
console.log('tools:', tools.map(t => t.name).join(', '));
console.log('get_context description:', tools.find(t => t.name === 'get_context')?.description);
const r1: any = await client.callTool({ name: 'get_context', arguments: { request: 'エー社向けの提案書をまとめたい。価格と納期は？' } });
console.log('\n--- get_context ---\n' + r1.content[0].text);
const r2: any = await client.callTool({ name: 'get_context', arguments: { request: '今日の天気は？' } });
console.log('\n--- unrelated ---\n' + r2.content[0].text);
const r3: any = await client.callTool({ name: 'propose_decision', arguments: { project: 'a-sha', label: '納期', text: '2027年1月末', source: '11/25 電話' } });
const r4: any = await client.callTool({ name: 'get_document', arguments: { id: 'doc:2026-10-28-a-proposal-v1' } });
console.log('\n--- get_document ---\n' + r4.content[0].text);
console.log('\n--- propose ---\n' + r3.content[0].text);
await client.close();
