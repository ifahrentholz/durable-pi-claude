// Run a CLI (git, glab, jira) and resolve with its stdout.
//
// stdin is closed on purpose. execFile leaves it as an open pipe, and some CLIs read their input from
// a non-TTY stdin until EOF: `jira issue comment add KEY body` waited there until the timeout killed
// it, so no comment ever reached Jira.
import { execFile } from "node:child_process";

export type CliError = Error & { code?: number | string; killed?: boolean; stdout: string; stderr: string };

export function cli(
  bin: string,
  args: string[],
  options: { cwd?: string; timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }) as CliError);
        else resolve(stdout);
      },
    );
    child.stdin?.end();
  });
}
