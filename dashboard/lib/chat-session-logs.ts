import { mkdir, open } from "node:fs/promises";
import path from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveSessionLogPath(root: string, sessionId: string): string {
  if (!UUID_RE.test(sessionId)) throw new Error("invalid session");
  const base = path.resolve(root);
  const target = path.resolve(base, `${sessionId}.jsonl`);
  if (path.dirname(target) !== base) throw new Error("invalid session log path");
  return target;
}

export async function ensureSessionLogFile(sessionId: string): Promise<void> {
  const root = process.env.ARI_SESSION_LOG_DIR;
  if (!root) return;
  const target = resolveSessionLogPath(root, sessionId);
  await mkdir(path.dirname(target), { recursive: true });
  const handle = await open(target, "a");
  await handle.close();
}
