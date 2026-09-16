import { createInterface } from "node:readline/promises";

/**
 * One readline prompt with a fallback default (empty input accepts it). The CLI
 * owns all prompting — the core's generate is prompt-free — so this is the only
 * place stdin is read.
 */
export async function askWithDefault(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer.length > 0 ? answer : fallback;
  } finally {
    rl.close();
  }
}
