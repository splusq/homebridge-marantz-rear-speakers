import type { Logger } from '../src/avr.ts';

export interface TestLogger extends Logger {
  lines: { level: string; message: string }[];
}

export function testLogger(): TestLogger {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (message: string, ...parameters: unknown[]) => {
    let i = 0;
    lines.push({ level, message: message.replace(/%[sd]/g, () => String(parameters[i++])) });
  };
  return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

export async function waitFor(condition: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<number> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Date.now() - started;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
