import { spawn } from "child_process";
import { join } from "path";
import { existsSync } from "fs";

function getPythonPath(repoRoot: string): string {
  const win  = join(repoRoot, "agent", ".venv", "Scripts", "python.exe");
  const unix = join(repoRoot, "agent", ".venv", "bin", "python");
  if (existsSync(win))  return win;
  if (existsSync(unix)) return unix;
  return "python";
}

export function spawnAgent(repoRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const python = getPythonPath(repoRoot);
    const proc = spawn(python, ["-m", "agent"], {
      cwd: repoRoot,
      env: process.env,
    });

    let stderr = "";
    proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

    proc.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`Agent exited with code ${code}${stderr ? "\n" + stderr.slice(-500) : ""}`));
    });

    proc.on("error", (err: Error) => reject(err));
  });
}

export function parseRunTime(timeStr: string): { hour: number; minute: number } | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour   = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}
