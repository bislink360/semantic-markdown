/**
 * `smd read` and the MCP `read` tool: see core/read.ts, where the library's `readSmd` lives. `readDocument` is the
 * name the CLI and the MCP server use.
 */
export { readSmd as readDocument, READ_BUDGET, READ_MODES } from './core';
export type { ReadMode, ReadOptions, ReadResult, ReadFollow } from './core';
