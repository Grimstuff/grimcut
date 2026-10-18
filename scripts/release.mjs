// Build a signed release and the updater manifest (latest.json).
//
//   npm run release              build, sign, stage files in release/v<version>/
//   npm run release -- --publish also create the GitHub release with gh
//
// Signing key: TAURI_SIGNING_PRIVATE_KEY (path or contents), else
// %USERPROFILE%\.tauri\grimsuite.key. Password: TAURI_SIGNING_PRIVATE_KEY_PASSWORD
// (empty if the key has none). Never commit the key.

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "Grimstuff/grimcut";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publish = process.argv.includes("--publish");

const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const product = conf.productName;
// Cargo package name, which is the exe tauri builds.
const exeName = "grimcut.exe";
const tag = `v${version}`;

const pubkey = conf.plugins?.updater?.pubkey ?? "";
if (!pubkey || pubkey.startsWith("REPLACE_")) {
  fail("plugins.updater.pubkey in tauri.conf.json is not set. Paste the public key from `npx tauri signer generate` first.");
}

const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyPath = join(homedir(), ".tauri", "grimsuite.key");
  if (!existsSync(keyPath)) {
    fail(`No signing key. Set TAURI_SIGNING_PRIVATE_KEY or create ${keyPath}.`);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = keyPath;
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

// The tag must point at the commit that was built, so publish only clean, pushed work.
let commit = "";
if (publish) {
  if (git("status --porcelain --untracked-files=no")) fail("Commit your changes before --publish.");
  commit = git("rev-parse HEAD");
  if (!git(`branch -r --contains ${commit}`)) fail("Push this commit before --publish.");
}

console.log(`Building ${product} ${version} with updater artifacts…`);
// Updater artifacts only for releases, so a plain `npm run tauri build` never needs the key.
// Passed as a file because quoting inline JSON through cmd.exe is fragile.
const out = join(root, "release", tag);
mkdirSync(out, { recursive: true });
const extraConf = join(out, "updater.conf.json");
writeFileSync(extraConf, JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
execSync(`npx tauri build --config ${JSON.stringify(extraConf)}`, { cwd: root, env, stdio: "inherit" });

const target = join(root, "src-tauri", "target", "release");
const nsisDir = join(target, "bundle", "nsis");
const setupName = readdirSync(nsisDir).find((f) => f.includes(`_${version}_`) && f.endsWith("-setup.exe"));
if (!setupName) fail(`No ${version} setup exe in ${nsisDir}.`);
const sigPath = join(nsisDir, `${setupName}.sig`);
if (!existsSync(sigPath)) fail(`Missing ${sigPath}. Was the build signed?`);

// No CHANGELOG yet, so releases ship without notes. Edit them on GitHub if wanted.
const notes = "";
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/${setupName}`,
    },
  },
};

const portableName = `${product}_${version}_x64-portable.exe`;
copyFileSync(join(nsisDir, setupName), join(out, setupName));
copyFileSync(join(target, exeName), join(out, portableName));
writeFileSync(join(out, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(out, "notes.md"), notes + "\n");
console.log(`\nStaged in ${out}:\n  ${setupName}\n  ${portableName}\n  latest.json`);

if (!publish) {
  console.log(`\nUpload those three to a GitHub release tagged ${tag} (not a pre-release),`);
  console.log("or run again with --publish to do it with gh.");
  process.exit(0);
}

const files = [setupName, portableName, "latest.json"].map((f) => JSON.stringify(join(out, f))).join(" ");
execSync(
  `gh release create ${tag} ${files} --repo ${REPO} --target ${commit} --title "${product} ${displayVersion(version)}" --notes-file ${JSON.stringify(join(out, "notes.md"))}`,
  { cwd: root, stdio: "inherit" },
);
console.log(`\nPublished ${tag}. Installed copies find it with Check for updates.`);

function git(args) {
  return execSync(`git ${args}`, { cwd: root, encoding: "utf8" }).trim();
}

function displayVersion(v) {
  return v.replace(/\.0$/, "");
}

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}
