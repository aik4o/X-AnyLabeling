"use strict";

const assert = require("node:assert/strict");
const stats = require("./github_pr_statistics.user.js");

const pr = {
    number: 7,
    title: "修复导出",
    body: "fix export",
    url: "https://github.com/o/r/pull/7",
    state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-03T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    isDraft: false,
    author: { login: "alice" },
    authorAssociation: "NONE",
    comments: {
        totalCount: 2,
        pageInfo: { hasNextPage: false },
        nodes: [
            {
                author: { login: "maintainer" },
                authorAssociation: "OWNER",
                createdAt: "2026-01-02T00:00:00Z",
                updatedAt: "2026-01-02T01:00:00Z",
            },
            {
                author: { login: "alice" },
                authorAssociation: "NONE",
                createdAt: "2026-01-03T00:00:00Z",
                updatedAt: "2026-01-03T00:00:00Z",
            },
        ],
    },
    reviews: {
        totalCount: 0,
        pageInfo: { hasNextPage: false },
        nodes: [],
    },
    reviewComments: [],
    inlineCommentsComplete: true,
    timelineItems: {
        pageInfo: { hasNextPage: false },
        nodes: [
            {
                __typename: "ReadyForReviewEvent",
                createdAt: "2026-01-01T12:00:00Z",
            },
        ],
    },
    commits: { totalCount: 3 },
    additions: 20,
    deletions: 4,
    changedFiles: 2,
};

const analyzedPr = stats.analyzePullRequest(
    pr,
    Date.parse("2026-03-10T00:00:00Z"),
);
assert.equal(analyzedPr.language, "chinese");
assert.equal(analyzedPr.maintainerReplied, true);
assert.equal(analyzedPr.submitterReplied, true);
assert.equal(analyzedPr.everDraft, true);
assert.equal(analyzedPr.firstMaintainerResponseHours, 24);
assert.equal(analyzedPr.stale30, true);

const issue = {
    number: 8,
    title: "Crash on start",
    body: "details",
    url: "https://github.com/o/r/issues/8",
    state: "CLOSED",
    stateReason: "COMPLETED",
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-03T00:00:00Z",
    closedAt: "2026-02-03T00:00:00Z",
    author: { login: "bob" },
    authorAssociation: "NONE",
    labels: {
        pageInfo: { hasNextPage: false },
        nodes: [{ name: "bug" }, { name: "good first issue" }],
    },
    closedByPullRequestsReferences: { totalCount: 1 },
    comments: {
        totalCount: 1,
        pageInfo: { hasNextPage: false },
        nodes: [
            {
                author: { login: "maintainer" },
                authorAssociation: "MEMBER",
                createdAt: "2026-02-01T06:00:00Z",
                updatedAt: "2026-02-01T06:00:00Z",
            },
        ],
    },
};

const analyzedIssue = stats.analyzeIssue(issue);
assert.equal(analyzedIssue.categories.bug, true);
assert.equal(analyzedIssue.categories.goodFirst, true);
assert.equal(analyzedIssue.closedByPr, true);
assert.equal(analyzedIssue.firstResponseHours, 6);

const commitEntries = [
    {
        author: { login: "maintainer" },
        total: 30,
        weeks: [{ w: 1787529600, c: 3 }],
    },
    {
        author: { login: "alice" },
        total: 10,
        weeks: [{ w: 1787529600, c: 1 }],
    },
];
const commits = stats.analyzeCommitContributors(commitEntries);
assert.equal(commits.totalCommits, 40);
assert.equal(commits.top1Share, 0.75);

const contributors = stats.buildContributorStatistics(
    [pr],
    [issue],
    commitEntries,
    true,
);
assert.equal(
    contributors.rows.find((row) => row.login === "alice").firstTimeContributor,
    true,
);
assert.equal(
    contributors.rows.find((row) => row.login === "maintainer").core,
    true,
);

console.log("github_pr_statistics tests passed");
