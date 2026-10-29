export const prepareSlateArtifactsCommand = `node --input-type=module -e '
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";

const hasPackage = existsSync("package.json");
const manifest = hasPackage ? JSON.parse(readFileSync("package.json", "utf8")) : {};
if (hasPackage) execFileSync("pnpm", ["install", "--frozen-lockfile"], { stdio: "inherit" });
if (manifest.scripts?.build) {
  execFileSync("pnpm", ["build"], { stdio: "inherit" });
} else {
  mkdirSync("build/client", { recursive: true });
  if (existsSync("public")) cpSync("public", "build/client", { recursive: true });
}
'`
