#!/usr/bin/env bun
/**
 * env:doctor — compare the current environment against .env.example and print
 * what is still missing, with the "where do I get this" note for each one.
 *
 *   bun run env:doctor                 # checks process.env + .env.local
 *   bun run env:doctor .env.production # checks process.env + that file
 *
 * Values are never printed. Zero dependencies on purpose: this must work before
 * `bun install` has ever run.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = resolve(ROOT, ".env.example");
const envFileArg = process.argv[2] ?? ".env.local";
const ENV_FILE = resolve(ROOT, envFileArg);

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (colour ? `\u001b[31m${s}\u001b[0m` : s);
const green = (s) => (colour ? `\u001b[32m${s}\u001b[0m` : s);
const dim = (s) => (colour ? `\u001b[2m${s}\u001b[0m` : s);
const bold = (s) => (colour ? `\u001b[1m${s}\u001b[0m` : s);

const RULE = /^#\s*[-=]{5,}\s*$/;

/**
 * Parse .env.example into ordered { section, key, comment } entries.
 * Sections are the `# ---- / # Title / # ----` banners; a variable's comment is
 * the contiguous run of `#` lines directly above it.
 */
function parseExample(text) {
  const lines = text.split("\n").map((line) => line.trim());
  const entries = [];
  let section = "General";
  let comment = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Section banner: rule / title / rule.
    if (RULE.test(line)) {
      const title = lines[i + 1] ?? "";
      let close = i + 2;
      while (close < lines.length && !RULE.test(lines[close]) && lines[close].startsWith("#")) {
        close += 1;
      }
      if (title.startsWith("#") && RULE.test(lines[close] ?? "")) {
        section = title.replace(/^#\s?/, "").trim() || section;
        i = close;
        comment = [];
        continue;
      }
      comment = [];
      continue;
    }

    if (line.startsWith("#")) {
      comment.push(line.replace(/^#\s?/, ""));
      continue;
    }
    if (line === "") {
      comment = [];
      continue;
    }

    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    entries.push({ section, key: line.slice(0, eq).trim(), comment: comment.join(" ") });
    comment = [];
  }

  return entries;
}

/** Minimal .env parser — good enough for KEY=value and KEY="value". */
function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

if (!existsSync(EXAMPLE)) {
  console.error(red(`Cannot find ${EXAMPLE}`));
  process.exit(1);
}

const entries = parseExample(readFileSync(EXAMPLE, "utf8"));
const fileEnv = parseEnvFile(ENV_FILE);
const lookup = (key) => {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess.trim() !== "") return "process.env";
  const fromFile = fileEnv[key];
  if (fromFile !== undefined && fromFile.trim() !== "") return envFileArg;
  return null;
};

console.log(bold("\nPartyBooth environment check"));
console.log(dim(`  .env.example : ${EXAMPLE}`));
console.log(
  dim(`  overlay file : ${ENV_FILE}${existsSync(ENV_FILE) ? "" : " (not found — that is fine)"}`),
);

let missing = 0;
let seenSection = null;

for (const entry of entries) {
  if (entry.section !== seenSection) {
    seenSection = entry.section;
    console.log(`\n${bold(entry.section)}`);
  }
  const source = lookup(entry.key);
  if (source) {
    console.log(`  ${green("set")}     ${entry.key} ${dim(`(${source})`)}`);
  } else {
    missing += 1;
    console.log(`  ${red("unset")}   ${entry.key}`);
    if (entry.comment) console.log(dim(`          ${entry.comment}`));
  }
}

console.log(
  `\n${missing === 0 ? green("Everything in .env.example is set.") : red(`${missing} variable(s) unset.`)}`,
);
console.log(
  dim(
    "Unset is not automatically a problem — many variables are optional and the app degrades gracefully. Read the note under each one.\n",
  ),
);
