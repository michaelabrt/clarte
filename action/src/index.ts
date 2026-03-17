import * as core from "@actions/core";
import * as github from "@actions/github";
import { runCiMode } from "../../src/cli/ci";
import { formatComment } from "./comment";

const MARKER = "<!-- clarte-ci-review -->";

async function run(): Promise<void> {
  try {
    const token = core.getInput("github-token", { required: true });
    const workingDir = core.getInput("working-directory") || ".";
    const commentMode = core.getInput("comment-mode") || "update";
    const maxFiles = parseInt(core.getInput("max-files") || "50", 10);
    const verbose = core.isDebug();

    const octokit = github.getOctokit(token);
    const context = github.context;

    if (!context.payload.pull_request) {
      core.info("Not a pull request event, skipping.");
      return;
    }

    const prNumber = context.payload.pull_request.number;
    const baseSha = context.payload.pull_request.base?.sha;

    // Get changed files from the PR (paginated for large PRs)
    const prFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
      ...context.repo,
      pull_number: prNumber,
      per_page: 100,
    });

    let changedFiles = prFiles
      .filter((f) => f.status !== "removed")
      .map((f) => f.filename);

    if (maxFiles > 0 && changedFiles.length > maxFiles) {
      core.warning(`PR has ${changedFiles.length} changed files, analyzing first ${maxFiles}.`);
      changedFiles = changedFiles.slice(0, maxFiles);
    }

    if (changedFiles.length === 0) {
      core.info("No changed files to analyze.");
      core.setOutput("has-findings", false);
      core.setOutput("co-change-count", 0);
      return;
    }

    core.info(`Analyzing ${changedFiles.length} changed files...`);

    // Run clarte CI analysis
    const result = await runCiMode(workingDir, changedFiles, baseSha, verbose);

    // Set outputs
    core.setOutput("has-findings", result.hasFindings);
    core.setOutput("co-change-count", result.missingCoChanges.length);
    core.setOutput("analysis-json", JSON.stringify(result));

    // Post/update PR comment
    if (commentMode !== "none") {
      const commentBody = `${MARKER}\n${formatComment(result)}`;

      if (commentMode === "update") {
        const { data: comments } = await octokit.rest.issues.listComments({
          ...context.repo,
          issue_number: prNumber,
          per_page: 100,
        });

        const existing = comments.find((c) => c.body?.includes(MARKER));

        if (existing) {
          const { data: updated } = await octokit.rest.issues.updateComment({
            ...context.repo,
            comment_id: existing.id,
            body: commentBody,
          });
          core.setOutput("comment-id", updated.id);
          core.info(`Updated existing comment #${updated.id}`);
        } else {
          const { data: created } = await octokit.rest.issues.createComment({
            ...context.repo,
            issue_number: prNumber,
            body: commentBody,
          });
          core.setOutput("comment-id", created.id);
          core.info(`Created comment #${created.id}`);
        }
      } else {
        const { data: created } = await octokit.rest.issues.createComment({
          ...context.repo,
          issue_number: prNumber,
          body: commentBody,
        });
        core.setOutput("comment-id", created.id);
        core.info(`Created comment #${created.id}`);
      }
    }

    // Summary
    core.info(
      `Findings: ${result.hasFindings ? "yes" : "none"} | ` +
        `${result.missingCoChanges.length} co-change warnings | ` +
        `${result.chokepoints.length} chokepoints | ` +
        `${result.tightCouplings.length} tight couplings`,
    );
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
