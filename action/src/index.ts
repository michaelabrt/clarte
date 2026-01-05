import * as core from "@actions/core";
import * as github from "@actions/github";
import { runCiMode } from "../../src/cli/ci.js";
import { formatComment } from "./comment.js";
import type { RiskLevel } from "../../src/analysis/ci.js";

const MARKER = "<!-- clarte-ci-review -->";

async function run(): Promise<void> {
  try {
    const token = core.getInput("github-token", { required: true });
    const workingDir = core.getInput("working-directory") || ".";
    const riskThreshold = (core.getInput("risk-threshold") || "medium") as RiskLevel;
    const failOnCritical = core.getBooleanInput("fail-on-critical");
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
      core.setOutput("risk-level", "low");
      core.setOutput("high-risk-count", 0);
      return;
    }

    core.info(`Analyzing ${changedFiles.length} changed files...`);

    // Run clarte CI analysis
    const result = await runCiMode(workingDir, changedFiles, baseSha, verbose);

    // Set outputs
    core.setOutput("risk-level", result.summary.overallRisk);
    core.setOutput("high-risk-count", result.summary.highRiskFiles + result.summary.criticalRiskFiles);
    core.setOutput("analysis-json", JSON.stringify(result));

    // Post/update PR comment
    if (commentMode !== "none") {
      const commentBody = `${MARKER}\n${formatComment(result, riskThreshold)}`;

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
      `Risk: ${result.summary.overallRisk} | ` +
        `${result.summary.highRiskFiles + result.summary.criticalRiskFiles} high-risk files | ` +
        `${result.summary.missingTests} test gaps | ` +
        `${result.summary.coChangeWarnings} co-change warnings`,
    );

    // Fail if configured
    if (failOnCritical && result.summary.criticalRiskFiles > 0) {
      core.setFailed(
        `${result.summary.criticalRiskFiles} critical-risk file(s) detected. ` +
          `Review the PR comment for details.`,
      );
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
