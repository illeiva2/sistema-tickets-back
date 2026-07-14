/**
 * Punto de entrada de migraciones para deploys.
 *
 * Produccion conserva el comportamiento normal de `prisma migrate deploy`.
 * Staging ejecuta antes el baseline protegido del clon de Neon.
 */

import { execFileSync } from "child_process";
import path from "path";

function localExecutable(name: "prisma" | "tsx"): string {
  return path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

function run(executable: string, args: string[]) {
  execFileSync(executable, args, {
    env: process.env,
    stdio: "inherit",
  });
}

if (process.env.STAGING_ENV === "1") {
  console.log("Deploy staging: validando y preparando baseline Prisma.");
  run(localExecutable("prisma"), ["generate"]);
  run(localExecutable("tsx"), ["src/scripts/baseline-staging.ts"]);
}

run(localExecutable("prisma"), ["migrate", "deploy"]);
