import Anthropic from '@anthropic-ai/sdk';
import { config, isLlmConfigured } from '../config.js';

/**
 * Thin wrapper over the Anthropic SDK.
 *
 * The whole LLM layer is optional. Nothing here is on the critical path: if
 * the key is absent, a call fails, or the model returns something that does
 * not validate, the caller keeps the deterministic result and the response
 * says so. That is deliberate - an analyst should be able to run this on a
 * laptop with no credentials and still get a correct, auditable answer.
 */

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!isLlmConfigured()) return null;
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey!, maxRetries: 1 });
  return client;
}

export interface ToolCallOptions {
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Ask the model for one structured result via a forced tool call, which is far
 * more reliable than parsing JSON out of prose. Returns the raw tool input for
 * the caller to validate - never trusted as-is.
 */
export async function callStructured(options: ToolCallOptions): Promise<unknown | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  try {
    const response = await anthropic.messages.create(
      {
        model: config.anthropic.model,
        max_tokens: options.maxTokens ?? 2000,
        system: options.system,
        tools: [
          {
            name: options.toolName,
            description: options.toolDescription,
            input_schema: options.inputSchema as Anthropic.Tool['input_schema'],
          },
        ],
        tool_choice: { type: 'tool', name: options.toolName },
        messages: [{ role: 'user', content: options.prompt }],
      },
      { timeout: options.timeoutMs ?? 45_000 },
    );

    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === options.toolName) return block.input;
    }
    return null;
  } catch (err) {
    console.warn('[llm] call failed, continuing without it:', err instanceof Error ? err.message : err);
    return null;
  }
}
