import type { CallToolResult } from '@modelcontextprotocol/server';
import { errorForUser } from '../utils/errors.js';

export function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

export function failed(error: unknown): CallToolResult {
  const message = errorForUser(error);
  const data = { success: false, error: message };
  return { isError: true, content: [{ type: 'text', text: message }], structuredContent: data };
}

export async function safely<T extends Record<string, unknown>>(
  work: () => Promise<T>,
): Promise<CallToolResult> {
  try {
    return ok(await work());
  } catch (error) {
    return failed(error);
  }
}
