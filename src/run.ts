import * as core from "@actions/core";
import { exec, getExecOutput } from "@actions/exec";
import * as github from "@actions/github";
import type { PreState } from "@changesets/types";
import { type Package, getPackages } from "@manypkg/get-packages";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import semverLt from "semver/functions/lt.js";
import { Git } from "./git.ts";
import type { Octokit } from "./octokit.ts";
import readChangesetState from "./readChangesetState.ts";
import {
  getChangedPackages,
  getChangelogEntry,
  getVersionsByDirectory,
  isErrorWithCode,
  sortTheThings,
} from "./utils.ts";

const require = createRequire(import.meta.url);

// Converts a markdown string to Slack mrkdwn format.
// Slack natively renders triple-backtick code blocks, so no special handling is needed for them.
function markdownToSlackMrkdwn(markdown: string): string {
  // Protect code blocks and inline code from other replacements
  const codeBlocks: string[] = [];
  let result = markdown.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes: string[] = [];
  result = result.replace(/`[^`\n]+`/g, (match) => {
    inlineCodes.push(match);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Headers → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/gs, "*$1*");
  result = result.replace(/__(.+?)__/gs, "*$1*");
  // Italic: *text* → _text_ (single asterisk remaining after bold pass)
  result = result.replace(/(?<![*_])\*([^*\n]+)\*(?![*_])/g, "_$1_");
  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");
  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  // Unordered list items: - item → • item
  result = result.replace(/^[ \t]*[-*]\s+/gm, "• ");

  // Restore protected segments
  result = result.replace(
    /\x00IC(\d+)\x00/g,
    (_, i) => inlineCodes[parseInt(i)]
  );
  result = result.replace(
    /\x00CB(\d+)\x00/g,
    (_, i) => codeBlocks[parseInt(i)]
  );

  return result.trim();
}

// Splits a mrkdwn string into one or more section blocks, respecting Slack's 3000-char limit.
function splitIntoSlackSections(
  text: string
): { type: "section"; text: { type: "mrkdwn"; text: string } }[] {
  const MAX = 3000;
  const blocks: { type: "section"; text: { type: "mrkdwn"; text: string } }[] =
    [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: remaining },
      });
      break;
    }
    const slice = remaining.slice(0, MAX);
    const splitAt = Math.max(slice.lastIndexOf("\n"), 1);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: remaining.slice(0, splitAt).trimEnd() },
    });
    remaining = remaining.slice(splitAt).trimStart();
  }
  return blocks;
}

// GitHub Issues/PRs messages have a max size limit on the
// message body payload.
// `body is too long (maximum is 65536 characters)`.
// To avoid that, we ensure to cap the message to 60k chars.
const MAX_CHARACTERS_PER_MESSAGE = 60000;

const createRelease = async (
  octokit: Octokit,
  { pkg, tagName }: { pkg: Package; tagName: string }
) => {
  let changelog;
  try {
    changelog = await fs.readFile(path.join(pkg.dir, "CHANGELOG.md"), "utf8");
  } catch (err) {
    if (isErrorWithCode(err, "ENOENT")) {
      // if we can't find a changelog, the user has probably disabled changelogs
      return;
    }
    throw err;
  }
  let changelogEntry = getChangelogEntry(changelog, pkg.packageJson.version);
  if (!changelogEntry) {
    // we can find a changelog but not the entry for this version
    // if this is true, something has probably gone wrong
    throw new Error(
      `Could not find changelog entry for ${pkg.packageJson.name}@${pkg.packageJson.version}`
    );
  }

  await octokit.rest.repos.createRelease({
    name: tagName,
    tag_name: tagName,
    body: changelogEntry.content,
    prerelease: pkg.packageJson.version.includes("-"),
    ...github.context.repo,
  });
};

type PublishOptions = {
  script: string;
  githubToken: string;
  octokit: Octokit;
  createGithubReleases: boolean;
  git: Git;
  cwd: string;
  slackTitle?: string;
  slackChannel?: string;
};

type PublishedPackage = { name: string; version: string };

type PublishResult =
  | {
      published: true;
      publishedPackages: PublishedPackage[];
      slackPayload: any;
    }
  | {
      published: false;
    };

export async function runPublish({
  script,
  githubToken,
  git,
  octokit,
  createGithubReleases,
  cwd,
  slackTitle = "New Release",
  slackChannel,
}: PublishOptions): Promise<PublishResult> {
  let [publishCommand, ...publishArgs] = script.split(/\s+/);

  let changesetPublishOutput = await getExecOutput(
    publishCommand,
    publishArgs,
    { cwd, env: { ...process.env, GITHUB_TOKEN: githubToken } }
  );

  let { packages, tool } = await getPackages(cwd);
  let releasedPackages: Package[] = [];

  if (tool !== "root") {
    let newTagRegex = /New tag:\s+(@[^/]+\/[^@]+|[^/]+)@([^\s]+)/;
    let packagesByName = new Map(packages.map((x) => [x.packageJson.name, x]));

    for (let line of changesetPublishOutput.stdout.split("\n")) {
      let match = line.match(newTagRegex);
      if (match === null) {
        continue;
      }
      let pkgName = match[1];
      let pkg = packagesByName.get(pkgName);
      if (pkg === undefined) {
        throw new Error(
          `Package "${pkgName}" not found.` +
            "This is probably a bug in the action, please open an issue"
        );
      }
      releasedPackages.push(pkg);
    }

    if (createGithubReleases) {
      await Promise.all(
        releasedPackages.map(async (pkg) => {
          const tagName = `${pkg.packageJson.name}@${pkg.packageJson.version}`;
          await git.pushTag(tagName);
          await createRelease(octokit, { pkg, tagName });
        })
      );
    }
  } else {
    if (packages.length === 0) {
      throw new Error(
        `No package found.` +
          "This is probably a bug in the action, please open an issue"
      );
    }
    let pkg = packages[0];
    let newTagRegex = /New tag:/;

    for (let line of changesetPublishOutput.stdout.split("\n")) {
      let match = line.match(newTagRegex);

      if (match) {
        releasedPackages.push(pkg);
        if (createGithubReleases) {
          const tagName = `v${pkg.packageJson.version}`;
          await git.pushTag(tagName);
          await createRelease(octokit, { pkg, tagName });
        }
        break;
      }
    }
  }

  if (releasedPackages.length) {
    const packageBlocks = (
      await Promise.all(
        releasedPackages.map(async (pkg) => {
          try {
            const changelog = await fs.readFile(
              path.join(pkg.dir, "CHANGELOG.md"),
              "utf8"
            );
            const changelogEntry = getChangelogEntry(
              changelog,
              pkg.packageJson.version
            );
            const mrkdwn = markdownToSlackMrkdwn(changelogEntry.content);

            return [
              { type: "divider" } as const,
              {
                type: "section" as const,
                text: {
                  type: "mrkdwn" as const,
                  text: `*${pkg.packageJson.name}@${pkg.packageJson.version}*`,
                },
              },
              ...splitIntoSlackSections(mrkdwn),
            ];
          } catch {
            core.error(
              `Error parsing changelog for ${pkg.packageJson.name}. Is the changelog file missing?`
            );
            return [];
          }
        })
      )
    ).flat();

    return {
      published: true,
      publishedPackages: releasedPackages.map(({ packageJson }) => ({
        name: packageJson.name,
        version: packageJson.version,
      })),
      slackPayload: {
        ...(slackChannel ? { channel: slackChannel } : {}),
        unfurl_links: false,
        unfurl_media: false,
        text: slackTitle,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: slackTitle, emoji: true },
          },
          ...packageBlocks,
        ],
      },
    };
  }

  return {
    published: false,
  };
}

const requireChangesetsCliPkgJson = (cwd: string) => {
  try {
    return require(require.resolve("@changesets/cli/package.json", {
      paths: [cwd],
    }));
  } catch (err) {
    if (isErrorWithCode(err, "MODULE_NOT_FOUND")) {
      throw new Error(
        `Have you forgotten to install \`@changesets/cli\` in "${cwd}"?`,
        { cause: err }
      );
    }
    throw err;
  }
};

type GetMessageOptions = {
  hasPublishScript: boolean;
  branch: string;
  changedPackagesInfo: {
    highestLevel: number;
    private: boolean;
    content: string;
    header: string;
  }[];
  prBodyMaxCharacters: number;
  preState?: PreState;
};

export async function getVersionPrBody({
  hasPublishScript,
  preState,
  changedPackagesInfo,
  prBodyMaxCharacters,
  branch,
}: GetMessageOptions) {
  let messageHeader = `This PR was opened by the [Changesets release](https://github.com/changesets/action) GitHub action. When you're ready to do a release, you can merge this and ${
    hasPublishScript
      ? `the packages will be published to npm automatically`
      : `publish to npm yourself or [setup this action to publish automatically](https://github.com/changesets/action#with-publishing)`
  }. If you're not ready to do a release yet, that's fine, whenever you add more changesets to ${branch}, this PR will be updated.
`;
  let messagePrestate = !!preState
    ? `⚠️⚠️⚠️⚠️⚠️⚠️

\`${branch}\` is currently in **pre mode** so this branch has prereleases rather than normal releases. If you want to exit prereleases, run \`changeset pre exit\` on \`${branch}\`.

⚠️⚠️⚠️⚠️⚠️⚠️
`
    : "";
  let messageReleasesHeading = `# Releases`;

  let fullMessage = [
    messageHeader,
    messagePrestate,
    messageReleasesHeading,
    ...changedPackagesInfo.map((info) => `${info.header}\n\n${info.content}`),
  ].join("\n");

  // Check that the message does not exceed the size limit.
  // If not, omit the changelog entries of each package.
  if (fullMessage.length > prBodyMaxCharacters) {
    fullMessage = [
      messageHeader,
      messagePrestate,
      messageReleasesHeading,
      `\n> The changelog information of each package has been omitted from this message, as the content exceeds the size limit.\n`,
      ...changedPackagesInfo.map((info) => `${info.header}\n\n`),
    ].join("\n");
  }

  // Check (again) that the message is within the size limit.
  // If not, omit all release content this time.
  if (fullMessage.length > prBodyMaxCharacters) {
    fullMessage = [
      messageHeader,
      messagePrestate,
      messageReleasesHeading,
      `\n> All release information have been omitted from this message, as the content exceeds the size limit.`,
    ].join("\n");
  }

  return fullMessage;
}

type VersionOptions = {
  script?: string;
  githubToken: string;
  git: Git;
  octokit: Octokit;
  cwd?: string;
  prTitle?: string;
  commitMessage?: string;
  hasPublishScript?: boolean;
  prBodyMaxCharacters?: number;
  branch?: string;
};

type RunVersionResult = {
  pullRequestNumber: number;
};

export async function runVersion({
  script,
  githubToken,
  git,
  octokit,
  cwd = process.cwd(),
  prTitle = "Version Packages",
  commitMessage = "Version Packages",
  hasPublishScript = false,
  prBodyMaxCharacters = MAX_CHARACTERS_PER_MESSAGE,
  branch = github.context.ref.replace("refs/heads/", ""),
}: VersionOptions): Promise<RunVersionResult> {
  let versionBranch = `changeset-release/${branch}`;

  let { preState } = await readChangesetState(cwd);

  await git.prepareBranch(versionBranch);

  let versionsByDirectory = await getVersionsByDirectory(cwd);

  const env = { ...process.env, GITHUB_TOKEN: githubToken };

  if (script) {
    let [versionCommand, ...versionArgs] = script.split(/\s+/);
    await exec(versionCommand, versionArgs, { cwd, env });
  } else {
    let changesetsCliPkgJson = requireChangesetsCliPkgJson(cwd);
    let cmd = semverLt(changesetsCliPkgJson.version, "2.0.0")
      ? "bump"
      : "version";
    await exec(
      "node",
      [
        require.resolve("@changesets/cli/bin.js", {
          paths: [cwd],
        }),
        cmd,
      ],
      {
        cwd,
        env,
      }
    );
  }

  let changedPackages = await getChangedPackages(cwd, versionsByDirectory);
  let changedPackagesInfoPromises = Promise.all(
    changedPackages.map(async (pkg) => {
      let changelogContents = await fs.readFile(
        path.join(pkg.dir, "CHANGELOG.md"),
        "utf8"
      );

      let entry = getChangelogEntry(changelogContents, pkg.packageJson.version);
      return {
        highestLevel: entry.highestLevel,
        private: !!pkg.packageJson.private,
        content: entry.content,
        header: `## ${pkg.packageJson.name}@${pkg.packageJson.version}`,
      };
    })
  );

  const finalPrTitle = `${prTitle}${!!preState ? ` (${preState.tag})` : ""}`;
  const finalCommitMessage = `${commitMessage}${
    !!preState ? ` (${preState.tag})` : ""
  }`;

  /**
   * Fetch any existing pull requests that are open against the branch,
   * before we push any changes that may inadvertently close the existing PRs.
   *
   * (`@changesets/ghcommit` has to reset the branch to the same commit as the base,
   * which GitHub will then react to by closing the PRs)
   */
  const existingPullRequests = await octokit.rest.pulls.list({
    ...github.context.repo,
    state: "open",
    head: `${github.context.repo.owner}:${versionBranch}`,
    base: branch,
  });
  core.info(
    `Existing pull requests: ${JSON.stringify(
      existingPullRequests.data,
      null,
      2
    )}`
  );

  await git.pushChanges({ branch: versionBranch, message: finalCommitMessage });

  const changedPackagesInfo = (await changedPackagesInfoPromises)
    .filter((x) => x)
    .sort(sortTheThings);

  let prBody = await getVersionPrBody({
    hasPublishScript,
    preState,
    branch,
    changedPackagesInfo,
    prBodyMaxCharacters,
  });

  if (existingPullRequests.data.length === 0) {
    core.info("creating pull request");
    const { data: newPullRequest } = await octokit.rest.pulls.create({
      base: branch,
      head: versionBranch,
      title: finalPrTitle,
      body: prBody,
      ...github.context.repo,
    });

    return {
      pullRequestNumber: newPullRequest.number,
    };
  } else {
    const [pullRequest] = existingPullRequests.data;

    core.info(`updating found pull request #${pullRequest.number}`);
    await octokit.rest.pulls.update({
      pull_number: pullRequest.number,
      title: finalPrTitle,
      body: prBody,
      ...github.context.repo,
      state: "open",
    });

    return {
      pullRequestNumber: pullRequest.number,
    };
  }
}
