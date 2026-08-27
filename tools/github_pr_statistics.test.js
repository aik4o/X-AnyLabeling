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

async function testAllHistorySplitsPullsAndIssues() {
    const requests = [];
    global.GM_xmlhttpRequest = ({ data, onload }) => {
        const payload = JSON.parse(data);
        const variables = payload.variables;
        requests.push({
            fetchPulls: variables.fetchPulls,
            fetchIssues: variables.fetchIssues,
            query: payload.query,
        });
        const repository = {};
        if (variables.fetchPulls) {
            repository.pullRequests = {
                totalCount: 0,
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
            };
        }
        if (variables.fetchIssues) {
            repository.issues = {
                totalCount: 0,
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
            };
        }
        onload({
            status: 200,
            responseHeaders: "",
            responseText: JSON.stringify({
                data: {
                    repository,
                    rateLimit: {
                        cost: 1,
                        limit: 5000,
                        remaining: 4999,
                        resetAt: "2026-03-10T01:00:00Z",
                        used: 1,
                    },
                },
            }),
        });
    };

    await stats.fetchPullRequests(
        { owner: "o", name: "r" },
        "token",
        "all",
        () => {},
        {
            includeIssues: true,
            includeCommits: false,
            includeDraftHistory: false,
            completeInteractions: false,
        },
    );

    assert.deepEqual(
        requests.map(({ fetchPulls, fetchIssues }) => ({
            fetchPulls,
            fetchIssues,
        })),
        [
            { fetchPulls: true, fetchIssues: false },
            { fetchPulls: false, fetchIssues: true },
        ],
    );
    assert.match(requests[0].query, /comments\(first: 10\)/);
    assert.match(requests[0].query, /pullRequests\(\s+first: 100/);
    assert.doesNotMatch(requests[0].query, /id url/);

    requests.length = 0;
    await stats.fetchPullRequests(
        { owner: "o", name: "r" },
        "token",
        "open",
        () => {},
        {
            includeIssues: true,
            includeCommits: false,
            includeDraftHistory: false,
            completeInteractions: false,
        },
    );
    assert.deepEqual(
        requests.map(({ fetchPulls, fetchIssues }) => ({
            fetchPulls,
            fetchIssues,
        })),
        [{ fetchPulls: true, fetchIssues: true }],
    );
}

async function testGraphqlErrorDetails() {
    const logs = [];
    global.GM_xmlhttpRequest = ({ onload }) => {
        onload({
            status: 502,
            statusText: "Bad Gateway",
            responseHeaders:
                "content-type: text/plain\r\nx-github-request-id: TEST:123\r\nx-ratelimit-limit: 5000\r\nx-ratelimit-remaining: 4940\r\nx-ratelimit-used: 60\r\nx-ratelimit-reset: 1773104400\r\nx-ratelimit-resource: graphql\r\n",
            responseText: "upstream failure",
        });
    };

    await assert.rejects(
        stats.fetchPullRequests(
            { owner: "o", name: "r" },
            "token",
            "all",
            (message) => logs.push(message),
            {
                includeIssues: false,
                includeCommits: false,
                includeDraftHistory: false,
                completeInteractions: false,
            },
        ),
        (error) => {
            assert.match(error.message, /PR 第 1 页.*耗时/);
            assert.match(error.message, /HTTP 502 Bad Gateway/);
            assert.match(error.message, /Content-Type text\/plain/);
            assert.match(error.message, /GitHub Request ID TEST:123/);
            assert.match(error.message, /已用 60\/5000/);
            assert.match(error.message, /响应摘要：upstream failure/);
            return true;
        },
    );
    assert.match(logs[0], /对象上限 100\/页.*互动连接上限 10 条元数据/);
}

async function testRateLimitLookup() {
    global.GM_xmlhttpRequest = ({ method, url, onload }) => {
        assert.equal(method, "GET");
        assert.equal(url, "https://api.github.com/rate_limit");
        onload({
            status: 200,
            responseHeaders: "",
            responseText: JSON.stringify({
                resources: {
                    core: {
                        limit: 5000,
                        used: 18,
                        remaining: 4982,
                        reset: 1773104400,
                    },
                    graphql: {
                        limit: 5000,
                        used: 531,
                        remaining: 4469,
                        reset: 1773104400,
                    },
                },
            }),
        });
    };

    const rateLimits = await stats.fetchRateLimits("token");
    assert.equal(rateLimits.rest.used, 18);
    assert.equal(rateLimits.graphql.remaining, 4469);
    assert.equal(rateLimits.graphql.resource, "graphql");
    assert.equal(
        stats.formatRateLimitChange(
            {
                rest: { used: 18, resetAt: rateLimits.rest.resetAt },
                graphql: {
                    used: 471,
                    resetAt: rateLimits.graphql.resetAt,
                },
            },
            rateLimits,
        ),
        "分析期间额度变化：REST +0，GraphQL +60",
    );
}

testAllHistorySplitsPullsAndIssues()
    .then(testGraphqlErrorDetails)
    .then(testRateLimitLookup)
    .then(() => console.log("github_pr_statistics tests passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
