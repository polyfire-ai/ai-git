import { execSync, spawn } from "child_process";
import {
  tokenCount,
  getModelSize,
  splitString,
  generateWithTokenUsage,
} from "polyfact";
import chalk from "chalk";
import ellipsis from "helpers/ellipsis";
import { CommitConfig } from "types";

const validateGitRepository = () => {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      encoding: "utf8",
      stdio: "ignore",
    });
  } catch (e) {
    console.error("This is not a git repository");
    process.exit(1);
  }
};
const validatePolyfactToken = (config: CommitConfig) => {
  if (!config.polyfactToken) {
    console.error(
      "Please set POLYFACT_TOKEN ! See https://app.polyfact.com and export it as an environment variable."
    );
    process.exit(1);
  }
};

const getDiff = (config: CommitConfig): string => {
  const excludeFromDiff = config.excludeFromDiff || [];
  const diffFilter = config.diffFilter || "ACMRTUXB";
  const diffCommand = `git diff --staged \
      --no-ext-diff \
      --diff-filter=${diffFilter} \
      -- ${excludeFromDiff.map((pattern) => `':(exclude)${pattern}'`).join(" ")}
  `;

  const diff = execSync(diffCommand, { encoding: "utf8" });
  if (!diff) {
    console.error(
      "No detectable changes were found in the staged files !\nIt's possible that the files staged for commit do not have any modifications.\nPlease review your staged changes and, if necessary, commit them manually or make further adjustments before attempting an automated commit."
    );
    process.exit(1);
  }
  return diff;
};

const formatPrompt = (config: CommitConfig, diff: string) => `
  ${config.systemMessageCommitPrompt}
  Read the following git diff for multiple files and 
  write 1-2 sentences commit message in ${config.language}
  without mentioning lines or files.
  Explain why these changes were made (summarize the reasoning):
  ${diff}`;

export const autoCommit = async (config: CommitConfig) => {
  validateGitRepository();
  validatePolyfactToken(config);

  let diff = getDiff(config);
  let prompt = formatPrompt(config, diff);

  const tokenLength = tokenCount(prompt);
  const maxTokens = getModelSize(config.modelName) - config.maxTokensInResponse;

  console.info(chalk.green(`Executing auto-commit process...`));

  if (tokenLength > maxTokens) {
    console.log(
      "Diff size exceeds limit. Segmenting into multiple API requests"
    );
    const filenameRegex = /^a\/(.+?)\s+b\/(.+?)/;
    const diffByFiles = splitString(diff, maxTokens)
      .filter((fileDiff) => fileDiff.length > 0)
      .map(async (fileDiff) => {
        const match = fileDiff.match(filenameRegex);
        const filename = match ? match[1] : "Unknown file";
        const content = fileDiff
          .replaceAll(filename, "")
          .replaceAll("a/ b/\n", "");
        const chunkedPrompt = formatPrompt(config, content);
        return await generateWithTokenUsage(
          chunkedPrompt,
          {},
          { token: config.polyfactToken, endpoint: config.endpoint }
        )
          .then((res) => ({
            filename,
            changes: res.result.trim() as unknown as string,
          }))
          .catch((e) => {
            console.error(`Error during Polyfact request: ${e.message}`);
            process.exit(1);
          });
      });
    const mergeChanges = await Promise.all(diffByFiles);
    diff = mergeChanges
      .map((fileDiff) => `diff --git ${fileDiff.filename}\n${fileDiff.changes}`)
      .join("\n\n");
  }

  prompt = formatPrompt(config, diff);
  const res = await generateWithTokenUsage(
    prompt,
    {},
    { token: config.polyfactToken, endpoint: config.endpoint }
  ).catch((e) => {
    console.error(`Error during OpenAI request: ${e.message}`);
    process.exit(1);
  });

  const commitMessage = res.result.trim().split("\n")[0];
  try {
    const parsed = JSON.parse(commitMessage);

    if (parsed.error) {
      console.error(`Error during Polyfact request: ${parsed.error}`);
      process.exit(1);
    }
  } catch (e) {
    // do nothing
  }

  if (!config.autocommit) {
    console.info(
      `[INFO] Autocommit mode is OFF.\nGenerated commit message:`,
      chalk.yellow(`\n${commitMessage}`)
    );
  } else {
    console.info("Commit Message Generated by AI:");
    console.info("-".repeat(35));
    console.info(chalk.yellow(commitMessage));
    console.info("-".repeat(35));
    console.info("Proceeding with the commit using the above message...\n\n");

    const commit = `git commit -m "${ellipsis(
      commitMessage.replace(/"/g, ""),
      100
    )}"`;

    console.info(commit);
    execSync(commit, { encoding: "utf8" });
  }

  if (config.openCommitTextEditor) {
    spawn("git", ["commit", "--amend"], { stdio: "inherit" });
  }
  console.info("Completed successfully.");
};
