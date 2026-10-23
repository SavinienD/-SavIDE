// Prepares the embedded Python runtime used by the REPL kernel.
//
// Downloads a python-build-standalone CPython 3.12 build for the current OS,
// extracts it to src-tauri/binaries/python-runtime and installs IPython + dill
// plus the document readers used by `files.read` (openpyxl for xlsx,
// python-docx for docx, pypdf for pdf). An existing runtime that only lacks
// packages is completed in place instead of being downloaded again.
// The directory is bundled as a Tauri resource (see tauri.sidecars.conf.json);
// in dev, axecode-repl falls back to a system `python` when it is absent.
//
// Usage: node scripts/prepare-python.mjs [--force]

import { execFile as execFileCallback } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const PBS_RELEASE = "20241016";
const PY_VERSION = "3.12.7";
const PIP_PACKAGES = [
  "ipython>=8.20",
  "dill>=0.3.8",
  // axe:viewers — text extraction of office/pdf files in files.read.
  "openpyxl>=3.1",
  "python-docx>=1.1",
  "pypdf>=4.2",
];
// Import names checked after installation (same order as above).
const IMPORT_CHECK = "import IPython, dill, openpyxl, docx, pypdf";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const runtimeDir = path.join(projectRoot, "src-tauri", "binaries", "python-runtime");
const force = process.argv.includes("--force");

await main();

async function main() {
  const python = pythonExecutable(runtimeDir);
  if (!force && (await exists(python))) {
    if (await hasPackages(python)) {
      console.log(`python runtime ready: ${python}`);
      return;
    }
    // Runtime present but missing packages (e.g. added in a later version).
    await installPackages(python);
    return;
  }
  const triple = targetTriple();
  const archive = `cpython-${PY_VERSION}+${PBS_RELEASE}-${triple}-install_only.tar.gz`;
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${archive}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "axecode-python-"));
  const archivePath = path.join(tmpDir, archive);
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath));

  await fs.rm(runtimeDir, { recursive: true, force: true });
  await execFile("tar", ["-xzf", archivePath, "-C", tmpDir]);
  // The archive contains a top-level `python/` directory.
  await fs.mkdir(path.dirname(runtimeDir), { recursive: true });
  await fs.rename(path.join(tmpDir, "python"), runtimeDir);
  await fs.rm(tmpDir, { recursive: true, force: true });

  await installPackages(python);
}

async function installPackages(python) {
  console.log(`installing ${PIP_PACKAGES.join(", ")}`);
  await execFile(python, ["-m", "pip", "install", "--no-warn-script-location", "--disable-pip-version-check", ...PIP_PACKAGES], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!(await hasPackages(python))) {
    throw new Error(`packages not importable after installation (${IMPORT_CHECK})`);
  }
  console.log(`python runtime ready: ${python}`);
}

function targetTriple() {
  const arch = process.env.AXECODE_TARGET_ARCH || process.arch;
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  switch (process.platform) {
    case "win32":
      return `${cpu}-pc-windows-msvc`;
    case "darwin":
      return `${cpu}-apple-darwin`;
    default:
      return `${cpu}-unknown-linux-gnu`;
  }
}

function pythonExecutable(dir) {
  return process.platform === "win32" ? path.join(dir, "python.exe") : path.join(dir, "bin", "python3");
}

async function hasPackages(python) {
  try {
    await execFile(python, ["-c", IMPORT_CHECK]);
    return true;
  } catch {
    return false;
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
