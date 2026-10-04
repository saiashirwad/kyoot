import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const rows = [];
for (const unit of manifest) {
  const head = run("git", ["rev-parse", unit.branch]);
  const base = run("git", ["rev-parse", unit.base]);
  const remote = run("git", ["ls-remote", "origin", `refs/heads/${unit.branch}`]).split("\t")[0];
  const pr = JSON.parse(
    run("gh", [
      "pr",
      "view",
      String(unit.pr),
      "--json",
      "url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,statusCheckRollup",
    ]),
  );
  assert(remote === head, `Remote head differs for ${unit.branch}`);
  assert(
    pr.headRefOid === head && pr.headRefName === unit.branch,
    `PR head differs for ${unit.branch}`,
  );
  assert(pr.baseRefName === unit.base, `PR base differs for ${unit.branch}`);
  assert(pr.state === "OPEN" && !pr.isDraft, `PR is not ready and open for ${unit.branch}`);
  assert(pr.mergeable === "MERGEABLE", `PR mergeability is not confirmed for ${unit.branch}`);
  run("git", ["merge-base", "--is-ancestor", base, head]);
  const files = run("git", ["diff", "--name-only", base, head]).split("\n");
  assert(files[0], `Empty unit ${unit.branch}`);
  rows.push({
    ...unit,
    head,
    baseHead: base,
    remote,
    url: pr.url,
    mergeable: pr.mergeable,
    checks: pr.statusCheckRollup,
    files,
  });
}
process.stdout.write(
  JSON.stringify({ verifiedAt: new Date().toISOString(), units: rows }, null, 2) + "\n",
);
