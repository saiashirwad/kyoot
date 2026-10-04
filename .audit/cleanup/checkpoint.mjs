import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const project = process.cwd();
const resume =
  "/Users/texoport/.codex/plugins/cache/pstack-claude/pstack/0.9.66/skills/poteto-mode/scripts/resume.mjs";
const run = (command, args) =>
  execFileSync(command, args, { cwd: project, encoding: "utf8" }).trim();
const { directory } = JSON.parse(run(process.execPath, [resume, "begin", "--project", project]));
const note = join(directory, "resume.md");
const progress = process.argv.slice(2).join(" ");
if (!progress) throw new Error("Provide verified progress, live writers, and next actions.");
writeFileSync(
  note,
  `# Kyoot cleanup checkpoint

The user authorized the entire audit cleanup, autonomous routine decisions, commits, pushes, and a verified PR stack. Merge and full persistence or process-crash recovery are separate. The original main checkout and its untracked todo.md remain untouched.

Coordinator worktree is ${project}. Canonical workflow, handoff, design, decision trail, and verification reports are under .audit/cleanup in this worktree. Read them before continuing. Each worker uses its own worktree. Do not commit or reset a worktree with a live writer.

${progress}

## Current commit

${run("git", ["log", "-1", "--format=%H %s"])}

## Branches

${run("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/cleanup/"])}

## Working tree

${run("git", ["status", "--short"]) || "clean"}

## Worktrees

${run("git", ["worktree", "list", "--porcelain"])}

GitHub CLI is the resolved forge. Origin is unavailable. Unit PRs form a linear base-branch chain. Verify actual remote SHAs before delivery. No CI workflow existed at baseline. Never relax the per-finding regression and independent-verification predicate.
`,
);
process.stdout.write(
  run(process.execPath, [resume, "publish", "--project", project, "--note", note]) + "\n",
);
