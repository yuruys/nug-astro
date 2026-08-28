import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, rm } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

await execFileAsync(npmCommand, ["run", "build:astro"], { shell: true });
await execFileAsync(npmCommand, ["exec", "--", "pagefind", "--site", "dist"], { shell: true });
await rm("public/pagefind", { recursive: true, force: true });
await mkdir("public/pagefind", { recursive: true });
await cp("dist/pagefind", "public/pagefind", { recursive: true });