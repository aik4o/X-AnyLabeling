"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const stats = require("./github_pr_statistics.user.js");

const userscriptSource = fs.readFileSync(
    require.resolve("./github_pr_statistics.user.js"),
    "utf8",
);
assert.doesNotMatch(userscriptSource, /\brunAnalysis\(\);/);
assert.match(
    userscriptSource,
    /ui\.analyze\.addEventListener\("click", runAnalysis\)/,
);
assert.match(userscriptSource, /<button id="pause"[^>]*>暂停<\/button>/);
assert.match(
    userscriptSource,
    /ui\.pause\.addEventListener\("click", requestPause\)/,
);
assert.doesNotMatch(
    userscriptSource,
    /isDraft|includeDraftHistory|CONVERT_TO_DRAFT_EVENT|READY_FOR_REVIEW_EVENT/,
);
assert.match(userscriptSource, /let scope = "all";/);
assert.match(
    userscriptSource,
    /<button id="scope-all" class="active">全部历史<\/button>/,
);
assert.match(
    userscriptSource,
    /GitHub 实时额度复核失败；不使用本地累计值代替/,
);
assert.match(
    userscriptSource,
    /本次脚本数据请求（本地计数，不是账户额度）/,
);
assert.match(
    userscriptSource,
    /lastUsage = fetchedData\.usage;[\s\S]*lastRateLimits = await fetchRateLimits\(token\);[\s\S]*fetchedData\.rateLimits = lastRateLimits;/,
);

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
assert.equal(
    contributors.rows.some((row) => row.login === "bob"),
    false,
    "仅提交 Issue 的用户不应计入代码贡献者",
);

assert.equal(stats.percentage(1, 4), 25);
assert.equal(stats.percentage(1, 0), 0);
const chartMarkup = stats.barChartMarkup(
    "回复率",
    [["维护者 <回复>", 75, "3 / 4（75.00%）", "green"]],
);
assert.match(chartMarkup, /role="img"/);
assert.match(chartMarkup, /width:75\.00%/);
assert.match(chartMarkup, /维护者 &lt;回复&gt;/);
assert.match(chartMarkup, /tone-green/);

async function testSeparatedLocalAnalysis() {
    const progress = [];
    const originalRequest = global.GM_xmlhttpRequest;
    global.GM_xmlhttpRequest = () => {
        throw new Error("本地分析不应调用 API");
    };
    try {
        const result = await stats.analyzeRepositoryData(
            {
                raw: {
                    repository: { owner: "o", name: "r" },
                    scope: "all",
                    options: {},
                    fetchedAt: "2026-03-10T00:00:00Z",
                    pullRequests: [pr],
                    issues: [issue],
                    commitContributors: commitEntries,
                },
                coverage: { fullHistory: true },
                rateLimits: { graphql: null, rest: null },
                usage: {},
            },
            (message, state) => progress.push({ message, ...state }),
        );

        assert.equal(result.rows.length, 1);
        assert.equal(result.issueRows.length, 1);
        assert.equal(result.commitStats.totalCommits, 40);
        assert.deepEqual(
            progress.map((item) => item.value),
            [0, 40, 80, 85, 95, 98],
        );
        assert.match(
            progress.map((item) => item.message).join("\n"),
            /本地分析 PR 1\/1.*本地分析 Issue 1\/1.*贡献者聚合完成/s,
        );
    } finally {
        global.GM_xmlhttpRequest = originalRequest;
    }
}

async function testAllHistorySplitsPullsAndIssues() {
    const requests = [];
    global.GM_xmlhttpRequest = ({ data, onload }) => {
        const payload = JSON.parse(data);
        const variables = payload.variables;
        requests.push({
            fetchPulls: variables.fetchPulls,
            fetchIssues: variables.fetchIssues,
            pageSize: variables.pageSize,
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

    const fetched = await stats.fetchRepositoryData(
        { owner: "o", name: "r" },
        "token",
        "all",
        () => {},
        {
            includeIssues: true,
            includeCommits: false,
            completeInteractions: false,
        },
    );
    assert.equal("rows" in fetched, false);
    assert.deepEqual(fetched.raw.pullRequests, []);
    assert.deepEqual(fetched.raw.issues, []);

    assert.deepEqual(
        requests.map(({ fetchPulls, fetchIssues, pageSize }) => ({
            fetchPulls,
            fetchIssues,
            pageSize,
        })),
        [
            { fetchPulls: true, fetchIssues: false, pageSize: 100 },
            { fetchPulls: false, fetchIssues: true, pageSize: 100 },
        ],
    );
    assert.match(requests[0].query, /comments\(first: 10\)/);
    assert.match(requests[0].query, /pullRequests\(\s+first: \$pageSize/);
    assert.doesNotMatch(requests[0].query, /id url/);

    requests.length = 0;
    await stats.fetchRepositoryData(
        { owner: "o", name: "r" },
        "token",
        "open",
        () => {},
        {
            includeIssues: true,
            includeCommits: false,
            completeInteractions: false,
        },
    );
    assert.deepEqual(
        requests.map(({ fetchPulls, fetchIssues, pageSize }) => ({
            fetchPulls,
            fetchIssues,
            pageSize,
        })),
        [{ fetchPulls: true, fetchIssues: true, pageSize: 100 }],
    );
}

async function testGraphqlErrorDetails() {
    const logs = [];
    let graphqlRequests = 0;
    const previousReset = 1773104400;
    global.GM_xmlhttpRequest = ({ url, onload }) => {
        if (url === "https://api.github.com/rate_limit") {
            onload({
                status: 200,
                responseHeaders: "",
                responseText: JSON.stringify({
                    resources: {
                        core: {
                            limit: 5000,
                            used: 0,
                            remaining: 5000,
                            reset: previousReset + 3600,
                        },
                        graphql: {
                            limit: 5000,
                            used: 1,
                            remaining: 4999,
                            reset: previousReset + 3600,
                        },
                    },
                }),
            });
            return;
        }
        graphqlRequests += 1;
        onload({
            status: 502,
            statusText: "Bad Gateway",
            responseHeaders:
                "content-type: text/plain\r\nx-github-request-id: TEST:123\r\nx-ratelimit-limit: 5000\r\nx-ratelimit-remaining: 4940\r\nx-ratelimit-used: 60\r\nx-ratelimit-reset: 1773104400\r\nx-ratelimit-resource: graphql\r\n",
            responseText: "upstream failure",
        });
    };

    await assert.rejects(
        stats.fetchRepositoryData(
            { owner: "o", name: "r" },
            "token",
            "all",
            (message) => logs.push(message),
            {
                includeIssues: false,
                includeCommits: false,
                completeInteractions: false,
            },
            {
                rest: null,
                graphql: {
                    limit: 5000,
                    used: 60,
                    remaining: 4940,
                    resetAt: new Date(previousReset * 1000).toISOString(),
                    resource: "graphql",
                },
            },
        ),
        (error) => {
            assert.match(error.message, /PR 第 1 页.*耗时/);
            assert.match(error.message, /HTTP 502 Bad Gateway/);
            assert.match(error.message, /Content-Type text\/plain/);
            assert.match(error.message, /GitHub Request ID TEST:123/);
            assert.match(error.message, /已用 60\/5000/);
            assert.match(error.message, /响应摘要：upstream failure/);
            assert.match(
                error.message,
                /额度窗口已重置.*新窗口已用 1\/5000.*无法排除/,
            );
            return true;
        },
    );
    assert.equal(graphqlRequests, 1);
    assert.match(logs[0], /对象上限 100\/页.*互动连接上限 10 条元数据/);
}

async function testGraphqlPauseAndResumeFromCheckpoint() {
    const resetAt = "2026-03-10T01:00:00Z";
    const startingRateLimits = {
        rest: null,
        graphql: {
            limit: 5000,
            used: 0,
            remaining: 5000,
            resetAt,
            resource: "graphql",
        },
    };
    const options = {
        includeIssues: false,
        includeCommits: false,
        completeInteractions: false,
    };
    let checkpoint = null;
    let request = 0;
    let shouldPause = false;
    global.GM_xmlhttpRequest = ({ data, onload }) => {
        request += 1;
        const variables = JSON.parse(data).variables;
        if (request === 1) {
            assert.equal(variables.prCursor, null);
            onload({
                status: 200,
                responseHeaders: "",
                responseText: JSON.stringify({
                    data: {
                        repository: {
                            pullRequests: {
                                totalCount: 2,
                                nodes: [{ number: 1 }],
                                pageInfo: {
                                    hasNextPage: true,
                                    endCursor: "cursor-1",
                                },
                            },
                        },
                        rateLimit: {
                            cost: 1,
                            limit: 5000,
                            remaining: 4999,
                            resetAt,
                            used: 1,
                        },
                    },
                }),
            });
            return;
        }
        assert.fail("暂停后不应请求下一页");
    };

    await assert.rejects(
        stats.fetchRepositoryData(
            { owner: "o", name: "r" },
            "token",
            "all",
            () => {},
            options,
            startingRateLimits,
            null,
            (state) => {
                checkpoint = state;
                if (state.prPage === 1) shouldPause = true;
            },
            () => shouldPause,
        ),
        (error) => error.paused === true,
    );
    assert.equal(request, 1);
    assert.equal(checkpoint.pullRequests.length, 1);
    assert.equal(checkpoint.prCursor, "cursor-1");
    assert.equal(checkpoint.prPage, 1);

    const resumeLogs = [];
    global.GM_xmlhttpRequest = ({ data, onload }) => {
        const variables = JSON.parse(data).variables;
        assert.equal(variables.prCursor, "cursor-1");
        assert.equal(variables.pageSize, 100);
        onload({
            status: 200,
            responseHeaders: "",
            responseText: JSON.stringify({
                data: {
                    repository: {
                        pullRequests: {
                            totalCount: 2,
                            nodes: [{ number: 2 }],
                            pageInfo: {
                                hasNextPage: false,
                                endCursor: null,
                            },
                        },
                    },
                    rateLimit: {
                        cost: 1,
                        limit: 5000,
                        remaining: 4998,
                        resetAt,
                        used: 2,
                    },
                },
            }),
        });
    };

    const result = await stats.fetchRepositoryData(
        { owner: "o", name: "r" },
        "token",
        "all",
        (message) => resumeLogs.push(message),
        options,
        startingRateLimits,
        checkpoint,
        (state) => {
            checkpoint = state;
        },
    );
    assert.deepEqual(
        result.raw.pullRequests.map((pr) => pr.number),
        [1, 2],
    );
    assert.equal(result.usage.graphqlRequests, 2);
    assert.equal(result.usage.graphqlPoints, 2);
    assert.match(resumeLogs[0], /恢复读取检查点.*已有 PR 1\/2/);
    assert.match(resumeLogs.join("\n"), /GraphQL 第 2 次请求完成/);
}

async function testSafeGraphqlPageFallback() {
    const logs = [];
    const pageSizes = [];
    const previousReset = 1773104400;
    const reset = previousReset;
    const resetAt = new Date(reset * 1000).toISOString();
    global.GM_xmlhttpRequest = ({ url, data, onload }) => {
        if (url === "https://api.github.com/rate_limit") {
            onload({
                status: 200,
                responseHeaders: "",
                responseText: JSON.stringify({
                    resources: {
                        core: {
                            limit: 5000,
                            used: 0,
                            remaining: 5000,
                            reset,
                        },
                        graphql: {
                            limit: 5000,
                            used: 103,
                            remaining: 4897,
                            reset,
                        },
                    },
                }),
            });
            return;
        }

        const variables = JSON.parse(data).variables;
        pageSizes.push(variables.pageSize);
        if (pageSizes.length === 1) {
            onload({
                status: 200,
                statusText: "OK",
                responseHeaders: "content-type: application/json\r\n",
                responseText: JSON.stringify({
                    errors: [
                        {
                            message:
                                "We couldn't respond to your request in time. Sorry about that.",
                        },
                    ],
                }),
            });
            return;
        }
        onload({
            status: 200,
            responseHeaders: "",
            responseText: JSON.stringify({
                data: {
                    repository: {
                        pullRequests: {
                            totalCount: 0,
                            nodes: [],
                            pageInfo: {
                                hasNextPage: false,
                                endCursor: null,
                            },
                        },
                    },
                    rateLimit: {
                        cost: 1,
                        limit: 5000,
                        remaining: 4896,
                        resetAt,
                        used: 104,
                    },
                },
            }),
        });
    };

    const result = await stats.fetchRepositoryData(
        { owner: "o", name: "r" },
        "token",
        "all",
        (message) => logs.push(message),
        {
            includeIssues: false,
            includeCommits: false,
            completeInteractions: false,
        },
        {
            rest: null,
            graphql: {
                limit: 5000,
                used: 100,
                remaining: 4900,
                resetAt: new Date(previousReset * 1000).toISOString(),
                resource: "graphql",
            },
        },
    );

    assert.deepEqual(pageSizes, [100, 90]);
    assert.equal(result.usage.graphqlRequests, 1);
    assert.equal(result.usage.graphqlPoints, 1);
    assert.match(logs.join("\n"), /失败请求已扣 3 points.*仍剩余 4897\/5000/);
    assert.match(logs.join("\n"), /对象上限 100 → 90\/页后自动重试/);
    assert.match(logs.join("\n"), /原因：We couldn't respond to your request in time/);
}

async function testGraphqlNetworkErrorDetailsAndRetry() {
    const logs = [];
    const pageSizes = [];
    const reset = 1773104400;
    const resetAt = new Date(reset * 1000).toISOString();
    global.GM_xmlhttpRequest = ({ url, data, onload, onerror }) => {
        if (url === "https://api.github.com/rate_limit") {
            onload({
                status: 200,
                responseHeaders: "",
                responseText: JSON.stringify({
                    resources: {
                        core: {
                            limit: 5000,
                            used: 0,
                            remaining: 5000,
                            reset,
                        },
                        graphql: {
                            limit: 5000,
                            used: 10,
                            remaining: 4990,
                            reset,
                        },
                    },
                }),
            });
            return;
        }

        const variables = JSON.parse(data).variables;
        pageSizes.push(variables.pageSize);
        if (pageSizes.length === 1) {
            onerror({
                status: 0,
                statusText: "NetworkError",
                readyState: 4,
                finalUrl: "https://api.github.com/graphql",
                responseHeaders: "",
                responseText: "",
            });
            return;
        }
        onload({
            status: 200,
            responseHeaders: "",
            responseText: JSON.stringify({
                data: {
                    repository: {
                        pullRequests: {
                            totalCount: 0,
                            nodes: [],
                            pageInfo: {
                                hasNextPage: false,
                                endCursor: null,
                            },
                        },
                    },
                    rateLimit: {
                        cost: 1,
                        limit: 5000,
                        remaining: 4989,
                        resetAt,
                        used: 11,
                    },
                },
            }),
        });
    };

    await stats.fetchRepositoryData(
        { owner: "o", name: "r" },
        "token",
        "all",
        (message) => logs.push(message),
        {
            includeIssues: false,
            includeCommits: false,
            completeInteractions: false,
        },
        {
            rest: null,
            graphql: {
                limit: 5000,
                used: 10,
                remaining: 4990,
                resetAt,
                resource: "graphql",
            },
        },
    );

    assert.deepEqual(pageSizes, [100, 90]);
    assert.match(
        logs.join("\n"),
        /网络层错误（GM_xmlhttpRequest\.onerror）/,
    );
    assert.match(logs.join("\n"), /网络状态 0（未收到 HTTP 响应）/);
    assert.match(logs.join("\n"), /statusText：NetworkError/);
    assert.match(logs.join("\n"), /readyState：4/);
    assert.match(logs.join("\n"), /对象上限 100 → 90\/页后自动重试/);
}

async function testPageSizeDropsAndRecoversByTen() {
    const logs = [];
    const pageSizes = [];
    const reset = 1773104400;
    const resetAt = new Date(reset * 1000).toISOString();
    let graphqlAttempts = 0;
    global.GM_xmlhttpRequest = ({ url, data, onload }) => {
        if (url === "https://api.github.com/rate_limit") {
            onload({
                status: 200,
                responseHeaders: "",
                responseText: JSON.stringify({
                    resources: {
                        core: {
                            limit: 5000,
                            used: 0,
                            remaining: 5000,
                            reset,
                        },
                        graphql: {
                            limit: 5000,
                            used: 1,
                            remaining: 4999,
                            reset,
                        },
                    },
                }),
            });
            return;
        }

        graphqlAttempts += 1;
        const variables = JSON.parse(data).variables;
        pageSizes.push(variables.pageSize);
        if (graphqlAttempts === 2) {
            onload({
                status: 502,
                statusText: "Bad Gateway",
                responseHeaders: "content-type: text/html\r\n",
                responseText: "<html>upstream failure</html>",
            });
            return;
        }

        const successfulPage =
            graphqlAttempts === 1 ? 1 : graphqlAttempts - 1;
        const hasNextPage = successfulPage < 4;
        onload({
            status: 200,
            responseHeaders: "",
            responseText: JSON.stringify({
                data: {
                    repository: {
                        pullRequests: {
                            totalCount: 4,
                            nodes: [],
                            pageInfo: {
                                hasNextPage,
                                endCursor: hasNextPage
                                    ? `next-${successfulPage}`
                                    : null,
                            },
                        },
                    },
                    rateLimit: {
                        cost: 1,
                        limit: 5000,
                        remaining: 5000 - successfulPage,
                        resetAt,
                        used: successfulPage,
                    },
                },
            }),
        });
    };

    await stats.fetchRepositoryData(
        { owner: "o", name: "r" },
        "token",
        "all",
        (message) => logs.push(message),
        {
            includeIssues: false,
            includeCommits: false,
            completeInteractions: false,
        },
        {
            rest: null,
            graphql: {
                limit: 5000,
                used: 0,
                remaining: 5000,
                resetAt,
                resource: "graphql",
            },
        },
    );

    assert.deepEqual(pageSizes, [100, 100, 90, 100, 100]);
    assert.match(logs.join("\n"), /对象上限 100 → 90\/页后自动重试/);
    assert.match(
        logs.join("\n"),
        /本页成功；后续页对象上限 90 → 100\/页/,
    );
}

async function testRateLimitLookup() {
    global.GM_xmlhttpRequest = ({ method, url, headers, nocache, onload }) => {
        assert.equal(method, "GET");
        assert.equal(url, "https://api.github.com/rate_limit");
        assert.equal(nocache, true);
        assert.equal(headers["Cache-Control"], "no-cache");
        assert.equal(headers.Pragma, "no-cache");
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

testSeparatedLocalAnalysis()
    .then(testAllHistorySplitsPullsAndIssues)
    .then(testGraphqlErrorDetails)
    .then(testGraphqlPauseAndResumeFromCheckpoint)
    .then(testSafeGraphqlPageFallback)
    .then(testGraphqlNetworkErrorDetailsAndRetry)
    .then(testPageSizeDropsAndRecoversByTen)
    .then(testRateLimitLookup)
    .then(() => console.log("github_pr_statistics tests passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
