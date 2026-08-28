// ==UserScript==
// @name         GitHub 仓库贡献统计
// @name:en      GitHub Repository Contribution Statistics
// @namespace    https://github.com/aik4o
// @version      0.6.20
// @description  低 API 成本统计仓库的 PR、Issue、贡献者与 Commit 活跃度
// @description:en Low-cost PR, issue, contributor, and commit activity statistics
// @match        https://github.com/*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.github.com
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    "use strict";

    const TOKEN_KEY = "github-pr-statistics-token";
    const OPTIONS_KEY = "github-pr-statistics-options-v1";
    const CHECKPOINT_KEY = "github-pr-statistics-checkpoint-v1";
    const CHECKPOINT_VERSION = 1;
    const SCRIPT_VERSION = "0.6.20";
    const DEFAULT_OPTIONS = Object.freeze({
        includeIssues: true,
        includeCommits: true,
        completeInteractions: false,
    });
    const MAX_PAGE_SIZE = 100;
    const MIN_PAGE_SIZE = 10;
    const PAGE_SIZE_STEP = 10;
    const INTERACTION_PREVIEW_SIZE = 10;
    const ANALYSIS_BATCH_SIZE = 50;
    const GRAPHQL_REQUEST_TIMEOUT_MS = 30000;
    const GRAPHQL_WATCHDOG_MS = 45000;
    const GRAPHQL_HEARTBEAT_MS = 10000;
    const CHART_COLORS = Object.freeze({
        blue: "var(--chart-blue)",
        green: "var(--chart-green)",
        orange: "var(--chart-orange)",
        purple: "var(--chart-purple)",
        red: "var(--chart-red)",
        gray: "var(--chart-gray)",
    });
    const REFERENCE_LINE_DASHES = Object.freeze([
        "12 5",
        "3 4",
        "12 4 3 4",
        "1 5",
    ]);
    const DAY_MS = 24 * 60 * 60 * 1000;
    const MAINTAINER_ASSOCIATIONS = new Set([
        "OWNER",
        "MEMBER",
        "COLLABORATOR",
    ]);
    const REPOSITORY_QUERY = `
        query(
          $owner: String!
          $name: String!
          $prCursor: String
          $issueCursor: String
          $prStates: [PullRequestState!]!
          $issueStates: [IssueState!]!
          $pageSize: Int!
          $fetchPulls: Boolean!
          $fetchIssues: Boolean!
        ) {
          repository(owner: $owner, name: $name) {
            pullRequests(
              first: $pageSize
              after: $prCursor
              states: $prStates
              orderBy: {field: CREATED_AT, direction: ASC}
            ) @include(if: $fetchPulls) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                number title body url state
                createdAt updatedAt closedAt mergedAt
                lastEditedAt editor { login }
                authorAssociation
                author { login }
                mergedBy { login }
                baseRefName headRefName
                additions deletions changedFiles
                commits(last: 1) {
                  totalCount
                  nodes {
                    commit {
                      committedDate
                      author { user { login } }
                    }
                  }
                }
                comments(first: ${INTERACTION_PREVIEW_SIZE}) {
                  totalCount
                  pageInfo { hasNextPage }
                  nodes {
                    author { login }
                    authorAssociation
                    createdAt updatedAt
                  }
                }
                reviews(first: ${INTERACTION_PREVIEW_SIZE}) {
                  totalCount
                  pageInfo { hasNextPage }
                  nodes {
                    author { login }
                    authorAssociation
                    createdAt submittedAt updatedAt
                  }
                }
              }
            }
            issues(
              first: $pageSize
              after: $issueCursor
              states: $issueStates
              orderBy: {field: CREATED_AT, direction: ASC}
            ) @include(if: $fetchIssues) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                number title body url state stateReason
                createdAt updatedAt closedAt
                lastEditedAt editor { login }
                authorAssociation
                author { login }
                labels(first: 20) {
                  pageInfo { hasNextPage }
                  nodes { name }
                }
                closedByPullRequestsReferences(first: 1, includeClosedPrs: true) {
                  totalCount
                }
                comments(first: ${INTERACTION_PREVIEW_SIZE}) {
                  totalCount
                  pageInfo { hasNextPage }
                  nodes {
                    author { login }
                    authorAssociation
                    createdAt updatedAt
                  }
                }
              }
            }
          }
          rateLimit { cost limit remaining resetAt used }
        }
    `;

    let ui;
    let currentRepository;
    let analysis = null;
    let scope = "all";
    let analyzedScope = null;
    let analyzedOptions = null;
    let loading = false;
    let pauseRequested = false;
    let fetchCheckpoint = null;
    let lastRateLimits = { graphql: null, rest: null };
    let lastUsage = {
        graphqlPoints: 0,
        graphqlRequests: 0,
        restRequests: 0,
        overflowRest: 0,
        inlineCommentRest: 0,
        commitStatsRest: 0,
    };
    let overflowItems = [];

    function fetchCheckpointKey(repository, selectedScope, options) {
        return JSON.stringify([
            repository.owner,
            repository.name,
            selectedScope,
            Boolean(options.includeIssues),
            Boolean(options.includeCommits),
            Boolean(options.completeInteractions),
        ]);
    }

    function compatibleFetchCheckpoint(repository, selectedScope, options) {
        return fetchCheckpoint?.version === CHECKPOINT_VERSION &&
            fetchCheckpoint.key ===
                fetchCheckpointKey(repository, selectedScope, options)
            ? fetchCheckpoint
            : null;
    }

    function clearFetchCheckpoint() {
        fetchCheckpoint = null;
        GM_deleteValue(CHECKPOINT_KEY);
    }

    function isBot(login) {
        return /\[bot\]$/i.test(login || "");
    }

    function eventFrom(item, type, timeField = "createdAt") {
        return {
            login: item.author?.login || "",
            association: item.authorAssociation || "",
            at: item[timeField] || item.createdAt || null,
            updatedAt: item.updatedAt || null,
            type,
        };
    }

    function interactionEvents(item) {
        return [
            ...(item.comments?.nodes || []).map((event) =>
                eventFrom(event, "comment"),
            ),
            ...(item.reviews?.nodes || []).map((event) =>
                eventFrom(event, "review", "submittedAt"),
            ),
            ...(item.reviewComments || []).map((event) =>
                eventFrom(event, "review_comment"),
            ),
        ].filter((event) => event.login && event.at);
    }

    function latestEvent(events) {
        return events.reduce((latest, event) => {
            if (!event || !event.at) return latest;
            return !latest || Date.parse(event.at) > Date.parse(latest.at)
                ? event
                : latest;
        }, null);
    }

    function earliestEvent(events) {
        return events.reduce((earliest, event) => {
            if (!event || !event.at) return earliest;
            return !earliest || Date.parse(event.at) < Date.parse(earliest.at)
                ? event
                : earliest;
        }, null);
    }

    function hoursBetween(start, end) {
        if (!start || !end) return null;
        const value = (Date.parse(end) - Date.parse(start)) / 3600000;
        return Number.isFinite(value) && value >= 0 ? value : null;
    }

    function ageInDays(isoDate, now = Date.now()) {
        if (!isoDate) return null;
        return Math.max(0, Math.floor((now - Date.parse(isoDate)) / DAY_MS));
    }

    function isMaintainerEvent(event, author = "") {
        return (
            event.login !== author &&
            !isBot(event.login) &&
            MAINTAINER_ASSOCIATIONS.has(event.association)
        );
    }

    function analyzePullRequest(pr, now = Date.now()) {
        const author = pr.author?.login || "";
        const events = interactionEvents(pr);
        const maintainerEvents = events
            .filter((event) => isMaintainerEvent(event, author))
            .map((event) => ({
                ...event,
                number: pr.number,
                title: pr.title,
                url: pr.url,
            }));
        const humanEvents = events.filter((event) => !isBot(event.login));
        if (author && !isBot(author) && pr.createdAt) {
            humanEvents.push({
                login: author,
                association: pr.authorAssociation,
                at: pr.createdAt,
                type: "pull_request",
            });
        }
        if (pr.editor?.login && !isBot(pr.editor.login) && pr.lastEditedAt) {
            humanEvents.push({
                login: pr.editor.login,
                association: "",
                at: pr.lastEditedAt,
                type: "body_edit",
            });
        }
        const lastCommit = pr.commits?.nodes?.[0]?.commit;
        const lastCommitAuthor = lastCommit?.author?.user?.login || "";
        if (lastCommitAuthor && !isBot(lastCommitAuthor) && lastCommit.committedDate) {
            humanEvents.push({
                login: lastCommitAuthor,
                association: "",
                at: lastCommit.committedDate,
                type: "commit",
            });
        }
        const firstResponse = earliestEvent(
            events.filter(
                (event) => event.login !== author && !isBot(event.login),
            ),
        );
        const firstMaintainerReply = earliestEvent(maintainerEvents);
        const lastHumanActivity = latestEvent(humanEvents);
        const staleDays = ageInDays(
            lastHumanActivity?.at || pr.createdAt,
            now,
        );

        return {
            number: pr.number,
            title: pr.title,
            body: pr.body,
            url: pr.url,
            author,
            authorAssociation: pr.authorAssociation,
            createdAt: pr.createdAt,
            updatedAt: pr.updatedAt,
            lastEditedAt: pr.lastEditedAt,
            closedAt: pr.closedAt,
            mergedAt: pr.mergedAt,
            merged: Boolean(pr.mergedAt),
            open: pr.state === "OPEN",
            closedWithoutMerge: pr.state === "CLOSED" && !pr.mergedAt,
            submitterReplied: events.some((event) => event.login === author),
            maintainerReplied: maintainerEvents.length > 0,
            latestMaintainerReply: latestEvent(maintainerEvents),
            firstResponse,
            firstMaintainerReply,
            firstResponseHours: hoursBetween(
                pr.createdAt,
                firstResponse?.at,
            ),
            firstMaintainerResponseHours: hoursBetween(
                pr.createdAt,
                firstMaintainerReply?.at,
            ),
            mergeHours: hoursBetween(pr.createdAt, pr.mergedAt),
            closeHours: hoursBetween(pr.createdAt, pr.closedAt),
            lastHumanActivity,
            staleDays,
            stale30: pr.state === "OPEN" && staleDays >= 30,
            stale90: pr.state === "OPEN" && staleDays >= 90,
            externalAuthor: !MAINTAINER_ASSOCIATIONS.has(
                pr.authorAssociation,
            ),
            conversationComments: pr.comments?.totalCount || 0,
            reviews: pr.reviews?.totalCount || 0,
            inlineReviewComments: (pr.reviewComments || []).length,
            interactionsComplete:
                !pr.comments?.pageInfo?.hasNextPage &&
                !pr.reviews?.pageInfo?.hasNextPage &&
                Boolean(pr.inlineCommentsComplete),
            additions: pr.additions || 0,
            deletions: pr.deletions || 0,
            changedFiles: pr.changedFiles || 0,
            commits: pr.commits?.totalCount || 0,
        };
    }

    function issueCategories(labels) {
        const names = labels.map((name) => name.toLowerCase());
        const has = (pattern) => names.some((name) => pattern.test(name));
        return {
            bug: has(/bug|defect|错误|缺陷/),
            feature: has(/feature|enhancement|功能|改进/),
            docs: has(/doc|documentation|文档/),
            goodFirst: has(/good[ -]?first|初次|新手/),
            helpWanted: has(/help[ -]?wanted|需要帮助/),
        };
    }

    function analyzeIssue(issue, now = Date.now()) {
        const author = issue.author?.login || "";
        const events = (issue.comments?.nodes || [])
            .map((event) => eventFrom(event, "issue_comment"))
            .filter((event) => event.login && event.at);
        const maintainerEvents = events
            .filter((event) => isMaintainerEvent(event, author))
            .map((event) => ({
                ...event,
                number: issue.number,
                title: issue.title,
                url: issue.url,
            }));
        const humanEvents = events.filter((event) => !isBot(event.login));
        if (author && !isBot(author) && issue.createdAt) {
            humanEvents.push({
                login: author,
                association: issue.authorAssociation,
                at: issue.createdAt,
                type: "issue",
            });
        }
        if (
            issue.editor?.login &&
            !isBot(issue.editor.login) &&
            issue.lastEditedAt
        ) {
            humanEvents.push({
                login: issue.editor.login,
                association: "",
                at: issue.lastEditedAt,
                type: "body_edit",
            });
        }
        const firstResponse = earliestEvent(
            events.filter(
                (event) => event.login !== author && !isBot(event.login),
            ),
        );
        const firstMaintainerReply = earliestEvent(maintainerEvents);
        const lastHumanActivity = latestEvent(humanEvents);
        const staleDays = ageInDays(
            lastHumanActivity?.at || issue.createdAt,
            now,
        );
        const labels = (issue.labels?.nodes || []).map((label) => label.name);

        return {
            number: issue.number,
            title: issue.title,
            body: issue.body,
            url: issue.url,
            author,
            authorAssociation: issue.authorAssociation,
            state: issue.state,
            stateReason: issue.stateReason,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
            lastEditedAt: issue.lastEditedAt,
            closedAt: issue.closedAt,
            open: issue.state === "OPEN",
            labels,
            categories: issueCategories(labels),
            comments: issue.comments?.totalCount || 0,
            commentsComplete: !issue.comments?.pageInfo?.hasNextPage,
            firstResponse,
            firstMaintainerReply,
            firstResponseHours: hoursBetween(
                issue.createdAt,
                firstResponse?.at,
            ),
            firstMaintainerResponseHours: hoursBetween(
                issue.createdAt,
                firstMaintainerReply?.at,
            ),
            maintainerReplied: maintainerEvents.length > 0,
            latestMaintainerReply: latestEvent(maintainerEvents),
            noResponse: !firstResponse,
            resolutionHours: hoursBetween(issue.createdAt, issue.closedAt),
            closedByPr:
                (issue.closedByPullRequestsReferences?.totalCount || 0) > 0,
            lastHumanActivity,
            staleDays,
            stale30: issue.state === "OPEN" && staleDays >= 30,
            stale90: issue.state === "OPEN" && staleDays >= 90,
        };
    }

    function median(values) {
        const sorted = values
            .filter((value) => Number.isFinite(value))
            .sort((a, b) => a - b);
        if (!sorted.length) return null;
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    function groupStatistics(rows) {
        return {
            count: rows.length,
            merged: rows.filter((row) => row.merged).length,
            closedWithoutMerge: rows.filter((row) => row.closedWithoutMerge)
                .length,
            submitterReplied: rows.filter((row) => row.submitterReplied).length,
            maintainerReplied: rows.filter((row) => row.maintainerReplied).length,
            stale30: rows.filter((row) => row.stale30).length,
            stale90: rows.filter((row) => row.stale90).length,
            medianFirstMaintainerResponseHours: median(
                rows.map((row) => row.firstMaintainerResponseHours),
            ),
            medianMergeHours: median(rows.map((row) => row.mergeHours)),
            medianCloseHours: median(rows.map((row) => row.closeHours)),
            latestMaintainerReply: latestEvent(
                rows.map((row) => row.latestMaintainerReply).filter(Boolean),
            ),
        };
    }

    function summarizePullRequests(rows, selectedScope) {
        const scopedRows =
            selectedScope === "open" ? rows.filter((row) => row.open) : rows;
        return {
            total: groupStatistics(scopedRows),
        };
    }

    function buildPullRequestTrend(rows, selectedScope) {
        const scopedRows =
            selectedScope === "open" ? rows.filter((row) => row.open) : rows;
        const dates = scopedRows
            .flatMap((row) => [row.createdAt, row.mergedAt, row.closedAt])
            .map((value) => String(value || "").slice(0, 10))
            .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
            .sort();
        if (!dates.length) return { labels: [], series: [] };

        const labels = [];
        const cursor = new Date(`${dates[0]}T00:00:00Z`);
        const end = new Date(`${dates.at(-1)}T00:00:00Z`);
        while (cursor <= end) {
            labels.push(cursor.toISOString().slice(0, 10));
            cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
        const buckets = new Map(
            labels.map((date) => [
                date,
                {
                    created: 0,
                    merged: 0,
                    closed: 0,
                },
            ]),
        );
        for (const row of scopedRows) {
            const created = buckets.get(
                String(row.createdAt || "").slice(0, 10),
            );
            if (created) created.created += 1;
            const merged = buckets.get(
                String(row.mergedAt || "").slice(0, 10),
            );
            if (merged) merged.merged += 1;
            if (!row.mergedAt && row.closedWithoutMerge) {
                const closed = buckets.get(
                    String(row.closedAt || "").slice(0, 10),
                );
                if (closed) closed.closed += 1;
            }
        }
        let open = 0;
        let merged = 0;
        let closed = 0;
        const openValues = [];
        const mergedValues = [];
        const closedValues = [];
        for (const date of labels) {
            const bucket = buckets.get(date);
            open = Math.max(
                0,
                open + bucket.created - bucket.merged - bucket.closed,
            );
            merged += bucket.merged;
            closed += bucket.closed;
            openValues.push(open);
            mergedValues.push(merged);
            closedValues.push(closed);
        }
        return {
            labels,
            series: [
                {
                    label: "Open PR",
                    tone: "green",
                    values: openValues,
                },
                {
                    label: "累计 Merge PR",
                    tone: "purple",
                    dash: "10 4",
                    values: mergedValues,
                },
                {
                    label: "累计 Close PR（未合并）",
                    tone: "red",
                    dash: "3 4",
                    values: closedValues,
                },
            ],
            note:
                selectedScope === "open"
                    ? "当前仅 Open 数据未包含历史 Merge/Close，紫色与红色线为 0。"
                    : "按创建、合并和未合并关闭日期计算每日收盘状态；未读取 reopen 时间线。",
        };
    }

    function summarizeIssues(rows, selectedScope) {
        const scopedRows =
            selectedScope === "open" ? rows.filter((row) => row.open) : rows;
        const categories = ["bug", "feature", "docs", "goodFirst", "helpWanted"];
        return {
            count: scopedRows.length,
            open: scopedRows.filter((row) => row.open).length,
            closed: scopedRows.filter((row) => !row.open).length,
            noResponse: scopedRows.filter((row) => row.noResponse).length,
            maintainerReplied: scopedRows.filter((row) => row.maintainerReplied)
                .length,
            closedByPr: scopedRows.filter((row) => row.closedByPr).length,
            stale30: scopedRows.filter((row) => row.stale30).length,
            stale90: scopedRows.filter((row) => row.stale90).length,
            medianFirstResponseHours: median(
                scopedRows.map((row) => row.firstResponseHours),
            ),
            medianFirstMaintainerResponseHours: median(
                scopedRows.map((row) => row.firstMaintainerResponseHours),
            ),
            medianResolutionHours: median(
                scopedRows.map((row) => row.resolutionHours),
            ),
            latestMaintainerReply: latestEvent(
                scopedRows
                    .map((row) => row.latestMaintainerReply)
                    .filter(Boolean),
            ),
            categories: Object.fromEntries(
                categories.map((category) => [
                    category,
                    scopedRows.filter((row) => row.categories[category]).length,
                ]),
            ),
        };
    }

    function analyzeCommitContributors(entries) {
        if (!Array.isArray(entries)) return null;
        const authors = entries
            .map((entry) => ({
                login: entry.author?.login || "(匿名或已删除账号)",
                total: Number(entry.total) || 0,
                weeks: Array.isArray(entry.weeks) ? entry.weeks : [],
            }))
            .sort((a, b) => b.total - a.total);
        const totalCommits = authors.reduce((sum, author) => sum + author.total, 0);
        const weekly = new Map();
        for (const author of authors) {
            for (const week of author.weeks) {
                weekly.set(week.w, (weekly.get(week.w) || 0) + (week.c || 0));
            }
        }
        const activeWeeks = [...weekly.entries()]
            .filter(([, count]) => count > 0)
            .sort(([left], [right]) => left - right);
        const monthlyMap = new Map();
        for (const [week, count] of activeWeeks) {
            const month = new Date(week * 1000).toISOString().slice(0, 7);
            monthlyMap.set(month, (monthlyMap.get(month) || 0) + count);
        }
        const share = (count) =>
            totalCommits
                ? authors.slice(0, count).reduce((sum, row) => sum + row.total, 0) /
                  totalCommits
                : 0;
        return {
            authors,
            contributorCount: authors.length,
            totalCommits,
            recentCommits: activeWeeks.reduce((sum, [, count]) => sum + count, 0),
            top1Share: share(1),
            top3Share: share(3),
            top5Share: share(5),
            lastActiveWeek: activeWeeks.length
                ? new Date(activeWeeks.at(-1)[0] * 1000).toISOString()
                : null,
            monthly: [...monthlyMap.entries()].slice(-12),
        };
    }

    function buildContributorStatistics(
        pullRequests,
        issues,
        commitEntries,
        fullHistory,
    ) {
        const people = new Map();
        const person = (login) => {
            if (!login) return null;
            if (!people.has(login)) {
                people.set(login, {
                    login,
                    associations: new Set(),
                    activityMonths: new Set(),
                    firstActivityAt: null,
                    lastActivityAt: null,
                    prCount: 0,
                    mergedPrCount: 0,
                    issueCount: 0,
                    commentCount: 0,
                    reviewCount: 0,
                    commitCount: 0,
                    codeContributor: false,
                    firstTimeContributorObserved: false,
                });
            }
            return people.get(login);
        };
        const activity = (login, association, at, kind) => {
            const row = person(login);
            if (!row || !at) return;
            if (association) row.associations.add(association);
            if (!row.firstActivityAt || Date.parse(at) < Date.parse(row.firstActivityAt)) {
                row.firstActivityAt = at;
            }
            if (!row.lastActivityAt || Date.parse(at) > Date.parse(row.lastActivityAt)) {
                row.lastActivityAt = at;
            }
            row.activityMonths.add(at.slice(0, 7));
            if (kind === "pr" || kind === "commit") {
                row.codeContributor = true;
            }
            if (kind === "pr") row.prCount += 1;
            if (kind === "merged_pr") row.mergedPrCount += 1;
            if (kind === "issue") row.issueCount += 1;
            if (kind === "comment") row.commentCount += 1;
            if (kind === "review") row.reviewCount += 1;
        };

        for (const pr of pullRequests) {
            activity(
                pr.author?.login,
                pr.authorAssociation,
                pr.createdAt,
                "pr",
            );
            const prAuthor = person(pr.author?.login);
            if (
                prAuthor &&
                ["FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR"].includes(
                    pr.authorAssociation,
                )
            ) {
                prAuthor.firstTimeContributorObserved = true;
            }
            if (pr.mergedAt) {
                const author = person(pr.author?.login);
                if (author) author.mergedPrCount += 1;
            }
            activity(pr.editor?.login, "", pr.lastEditedAt, "edit");
            const lastCommit = pr.commits?.nodes?.[0]?.commit;
            activity(
                lastCommit?.author?.user?.login,
                "",
                lastCommit?.committedDate,
                "commit",
            );
            for (const event of interactionEvents(pr)) {
                activity(
                    event.login,
                    event.association,
                    event.at,
                    event.type === "review" ? "review" : "comment",
                );
            }
        }
        for (const issue of issues) {
            activity(
                issue.author?.login,
                issue.authorAssociation,
                issue.createdAt,
                "issue",
            );
            activity(issue.editor?.login, "", issue.lastEditedAt, "edit");
            for (const comment of issue.comments?.nodes || []) {
                const event = eventFrom(comment, "comment");
                activity(event.login, event.association, event.at, "comment");
            }
        }
        for (const entry of commitEntries || []) {
            const login = entry.author?.login || "(匿名或已删除账号)";
            const row = person(login);
            row.codeContributor = true;
            row.commitCount += Number(entry.total) || 0;
            for (const week of entry.weeks || []) {
                if (week.c) {
                    activity(
                        login,
                        "",
                        new Date(week.w * 1000).toISOString(),
                        "commit",
                    );
                }
            }
        }

        const codeContributors = [...people.values()].filter(
            (row) => row.codeContributor,
        );
        const rows = codeContributors.map((row) => {
            const bot = isBot(row.login);
            const internal = [...row.associations].some((association) =>
                MAINTAINER_ASSOCIATIONS.has(association),
            );
            const core =
                !bot &&
                (internal ||
                    row.mergedPrCount >= 5 ||
                    row.reviewCount >= 10 ||
                    row.commitCount >= 20);
            return {
                ...row,
                associations: [...row.associations],
                activityMonths: [...row.activityMonths].sort(),
                activeMonths: row.activityMonths.size,
                bot,
                internal,
                external: !bot && !internal,
                firstTimeContributor: fullHistory
                    ? row.prCount === 1
                    : row.firstTimeContributorObserved,
                recurringExternal:
                    !bot &&
                    !internal &&
                    (row.prCount >= 2 || row.activityMonths.size >= 2),
                core,
                active30:
                    Boolean(row.lastActivityAt) &&
                    ageInDays(row.lastActivityAt) <= 30,
                active90:
                    Boolean(row.lastActivityAt) &&
                    ageInDays(row.lastActivityAt) <= 90,
                active365:
                    Boolean(row.lastActivityAt) &&
                    ageInDays(row.lastActivityAt) <= 365,
            };
        });
        rows.sort((a, b) =>
            String(b.lastActivityAt || "").localeCompare(
                String(a.lastActivityAt || ""),
            ),
        );
        const humanRows = rows.filter((row) => !row.bot);
        return {
            rows,
            count: humanRows.length,
            internal: humanRows.filter((row) => row.internal).length,
            external: humanRows.filter((row) => row.external).length,
            core: humanRows.filter((row) => row.core).length,
            recurringExternal: humanRows.filter((row) => row.recurringExternal)
                .length,
            firstTime: humanRows.filter((row) => row.firstTimeContributor)
                .length,
            active30: humanRows.filter((row) => row.active30).length,
            active90: humanRows.filter((row) => row.active90).length,
            active365: humanRows.filter((row) => row.active365).length,
        };
    }

    const summarize = summarizePullRequests;

    function rate(numerator, denominator) {
        return denominator
            ? `${percentage(numerator, denominator).toFixed(2)}%`
            : "—";
    }

    function percentage(numerator, denominator) {
        const value = (100 * Number(numerator)) / Number(denominator);
        return Number.isFinite(value) ? value : 0;
    }

    function formatRateLimit(value) {
        const name =
            value.resource === "graphql"
                ? "GraphQL"
                : value.resource === "core"
                  ? "REST"
                  : "API";
        return `${name} 额度：已用 ${value.used}/${value.limit}（剩余 ${value.remaining}）`;
    }

    function responseHeader(response, name) {
        return String(response.responseHeaders || "").match(
            new RegExp(`^${name}:\\s*(.+?)\\s*$`, "im"),
        )?.[1];
    }

    function rateLimitFromHeaders(rawHeaders) {
        const readNumber = (name) => {
            const match = String(rawHeaders || "").match(
                new RegExp(`^${name}:\\s*(\\d+)\\s*$`, "im"),
            );
            return match ? Number(match[1]) : null;
        };
        const limit = readNumber("x-ratelimit-limit");
        const remaining = readNumber("x-ratelimit-remaining");
        const used = readNumber("x-ratelimit-used");
        const reset = readNumber("x-ratelimit-reset");
        if ([limit, remaining, used, reset].includes(null)) return null;
        const resource = String(rawHeaders || "").match(
            /^x-ratelimit-resource:\s*(\S+)\s*$/im,
        )?.[1];
        return {
            limit,
            remaining,
            resource: resource?.toLowerCase() || "",
            used,
            resetAt: new Date(reset * 1000).toISOString(),
        };
    }

    function rememberRateLimit(value) {
        if (!value) return;
        const key = value.resource === "graphql" ? "graphql" : "rest";
        lastRateLimits[key] = value;
    }

    function formatRateLimits(rateLimits = lastRateLimits) {
        return [rateLimits.rest, rateLimits.graphql]
            .filter(Boolean)
            .map(
                (value) =>
                    `${formatRateLimit(value)}，重置时间 ${formatDate(
                        value.resetAt,
                    )}`,
            )
            .join("；");
    }

    function formatRateLimitChange(before, after) {
        const changes = [];
        for (const [label, key] of [
            ["REST", "rest"],
            ["GraphQL", "graphql"],
        ]) {
            const previous = before?.[key];
            const current = after?.[key];
            if (!previous || !current) continue;
            if (previous.resetAt !== current.resetAt) {
                changes.push(`${label} 额度窗口已重置`);
            } else {
                const delta = current.used - previous.used;
                changes.push(`${label} ${delta >= 0 ? "+" : ""}${delta}`);
            }
        }
        return changes.length ? `分析期间额度变化：${changes.join("，")}` : "";
    }

    function formatApiError(message, response) {
        const rateLimit = rateLimitFromHeaders(response.responseHeaders);
        const requestId = responseHeader(response, "x-github-request-id");
        const details = [message];
        if (requestId) details.push(`GitHub Request ID ${requestId}`);
        if (rateLimit) {
            details.push(
                `${formatRateLimit(rateLimit)}，重置时间 ${formatDate(rateLimit.resetAt)}`,
            );
        }
        return details.join("；");
    }

    function createTransportError(apiName, eventName, response = {}) {
        const status = Number(response?.status);
        const hasStatus = Number.isFinite(status);
        const details = [`${apiName} ${eventName}`];
        if (hasStatus) {
            details.push(
                status === 0
                    ? "网络状态 0（未收到 HTTP 响应）"
                    : `HTTP ${status}`,
            );
        }
        if (response?.statusText) {
            details.push(`statusText：${response.statusText}`);
        }
        if (response?.readyState !== undefined) {
            details.push(`readyState：${response.readyState}`);
        }
        if (response?.finalUrl) {
            details.push(`最终 URL：${response.finalUrl}`);
        }
        const requestId = responseHeader(response, "x-github-request-id");
        if (requestId) details.push(`GitHub Request ID ${requestId}`);
        const responseText = String(response?.responseText || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 160);
        if (responseText) details.push(`响应摘要：${responseText}`);
        const transportMessage = response?.error || response?.message;
        if (transportMessage) {
            details.push(`底层信息：${String(transportMessage)}`);
        }
        if (
            typeof navigator !== "undefined" &&
            typeof navigator.onLine === "boolean"
        ) {
            details.push(`navigator.onLine：${navigator.onLine}`);
        }
        if (
            status === 0 &&
            !response?.statusText &&
            !transportMessage &&
            !responseText
        ) {
            details.push(
                "浏览器/Tampermonkey 未暴露更具体原因（可能是临时断网、DNS、代理或 TLS 连接失败）",
            );
        }
        const error = new Error(details.join("；"));
        error.status = hasStatus ? status : null;
        error.transport = true;
        return error;
    }

    function parseRepository() {
        const parts = location.pathname.split("/").filter(Boolean);
        const repositoryTabs = new Set([
            "pull",
            "pulls",
            "issues",
            "commits",
            "graphs",
        ]);
        if (parts.length < 2) return null;
        if (parts.length > 2 && !repositoryTabs.has(parts[2])) return null;
        return { owner: parts[0], name: parts[1] };
    }

    function isRetryableGraphqlFailure(error) {
        return (
            error?.transport === true ||
            [500, 502, 503, 504].includes(Number(error?.status)) ||
            /请求超时|respond to your request in time|timed out|timeout/i.test(
                String(error?.message || error || ""),
            )
        );
    }

    function createPauseError() {
        const error = new Error("用户已暂停读取");
        error.paused = true;
        return error;
    }

    function requestGraphQL(query, token, variables, options = {}) {
        return new Promise((resolve, reject) => {
            const watchdogMs =
                options.watchdogMs ?? GRAPHQL_WATCHDOG_MS;
            const heartbeatMs =
                options.heartbeatMs ?? GRAPHQL_HEARTBEAT_MS;
            const onHeartbeat = options.onHeartbeat || (() => {});
            const startedAt = Date.now();
            let settled = false;
            let requestHandle = null;
            let heartbeatTimer = null;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(watchdogTimer);
                if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
                callback(value);
            };
            const watchdogTimer = setTimeout(() => {
                const error = createTransportError(
                    "GitHub GraphQL",
                    `应用层看门狗超时（${watchdogMs / 1000} 秒未收到 Tampermonkey 回调）`,
                    {
                        status: 0,
                        statusText: "ApplicationWatchdogTimeout",
                        readyState: 0,
                        finalUrl: "https://api.github.com/graphql",
                    },
                );
                finish(reject, error);
                try {
                    requestHandle?.abort?.();
                } catch (_error) {
                    // 请求已经由看门狗判定失败，底层 abort 失败不影响重试。
                }
            }, watchdogMs);
            if (heartbeatMs > 0) {
                heartbeatTimer = setInterval(() => {
                    if (!settled) {
                        onHeartbeat(
                            Math.round((Date.now() - startedAt) / 1000),
                        );
                    }
                }, heartbeatMs);
            }
            requestHandle = GM_xmlhttpRequest({
                method: "POST",
                url: "https://api.github.com/graphql",
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "X-GitHub-Api-Version": "2026-03-10",
                },
                data: JSON.stringify({ query, variables }),
                timeout: GRAPHQL_REQUEST_TIMEOUT_MS,
                onload(response) {
                    let payload;
                    try {
                        payload = JSON.parse(response.responseText);
                    } catch (_error) {
                        const responseText = String(
                            response.responseText || "",
                        );
                        const preview = responseText
                            .trim()
                            .replace(/\s+/g, " ")
                            .slice(0, 160);
                        const details = [
                            `HTTP ${response.status || "未知状态"}${
                                response.statusText
                                    ? ` ${response.statusText}`
                                    : ""
                            }`,
                            `响应 ${responseText.length} 字符`,
                        ];
                        const contentType = responseHeader(
                            response,
                            "content-type",
                        );
                        const requestId = responseHeader(
                            response,
                            "x-github-request-id",
                        );
                        if (contentType) {
                            details.push(`Content-Type ${contentType}`);
                        }
                        if (requestId) {
                            details.push(`GitHub Request ID ${requestId}`);
                        }
                        const rateLimit = rateLimitFromHeaders(
                            response.responseHeaders,
                        );
                        if (rateLimit) {
                            details.push(
                                `${formatRateLimit(rateLimit)}，重置时间 ${formatDate(rateLimit.resetAt)}`,
                            );
                        }
                        if (preview) details.push(`响应摘要：${preview}`);
                        const error = new Error(
                            `GitHub GraphQL 返回非 JSON；${details.join("；")}`,
                        );
                        error.status = response.status;
                        finish(reject, error);
                        return;
                    }
                    if (response.status !== 200) {
                        const error = new Error(
                            formatApiError(
                                payload.message ||
                                    `GitHub API 请求失败 (${response.status})`,
                                response,
                            ),
                        );
                        error.status = response.status;
                        finish(reject, error);
                        return;
                    }
                    if (payload.errors?.length) {
                        const error = new Error(
                            formatApiError(
                                payload.errors
                                    .map((item) => item.message)
                                    .join("；"),
                                response,
                            ),
                        );
                        error.status = response.status;
                        finish(reject, error);
                        return;
                    }
                    finish(resolve, payload.data);
                },
                onerror(response) {
                    finish(
                        reject,
                        createTransportError(
                            "GitHub GraphQL",
                            "网络层错误（GM_xmlhttpRequest.onerror）",
                            response,
                        ),
                    );
                },
                ontimeout(response) {
                    finish(
                        reject,
                        createTransportError(
                            "GitHub GraphQL",
                            "请求超时（GM_xmlhttpRequest.ontimeout）",
                            response,
                        ),
                    );
                },
            });
        });
    }

    function requestRest(token, url, options = {}) {
        const acceptedStatuses = options.acceptedStatuses || [200];
        const expectArray = options.expectArray !== false;
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "X-GitHub-Api-Version": "2026-03-10",
                    ...(options.headers || {}),
                },
                nocache: options.nocache === true,
                timeout: 30000,
                onload(response) {
                    let payload = null;
                    if (String(response.responseText || "").trim()) {
                        try {
                            payload = JSON.parse(response.responseText);
                        } catch (_error) {
                            reject(
                                new Error("GitHub REST API 返回了无法解析的数据"),
                            );
                            return;
                        }
                    }
                    if (!acceptedStatuses.includes(response.status)) {
                        reject(
                            new Error(
                                formatApiError(
                                    payload?.message ||
                                        `GitHub REST API 请求失败 (${response.status})`,
                                    response,
                                ),
                            ),
                        );
                        return;
                    }
                    if (
                        response.status === 200 &&
                        expectArray &&
                        !Array.isArray(payload)
                    ) {
                        reject(new Error("GitHub REST API 返回了意外的数据结构"));
                        return;
                    }
                    resolve({
                        data: payload,
                        items: Array.isArray(payload) ? payload : [],
                        status: response.status,
                        hasNextPage: /<[^>]+>;\s*rel="next"/i.test(
                            response.responseHeaders || "",
                        ),
                        rateLimit: rateLimitFromHeaders(
                            response.responseHeaders,
                        ),
                    });
                },
                onerror(response) {
                    reject(
                        createTransportError(
                            "GitHub REST API",
                            "网络层错误（GM_xmlhttpRequest.onerror）",
                            response,
                        ),
                    );
                },
                ontimeout(response) {
                    reject(
                        createTransportError(
                            "GitHub REST API",
                            "请求超时（GM_xmlhttpRequest.ontimeout）",
                            response,
                        ),
                    );
                },
            });
        });
    }

    async function fetchRateLimits(token) {
        const result = await requestRest(
            token,
            "https://api.github.com/rate_limit",
            {
                expectArray: false,
                nocache: true,
                headers: {
                    "Cache-Control": "no-cache",
                    Pragma: "no-cache",
                },
            },
        );
        const normalize = (value, resource) => {
            const limit = Number(value?.limit);
            const remaining = Number(value?.remaining);
            const used = Number(value?.used);
            const reset = Number(value?.reset);
            if (![limit, remaining, used, reset].every(Number.isFinite)) {
                return null;
            }
            return {
                limit,
                remaining,
                resource,
                used,
                resetAt: new Date(reset * 1000).toISOString(),
            };
        };
        const rateLimits = {
            rest: normalize(result.data?.resources?.core, "core"),
            graphql: normalize(result.data?.resources?.graphql, "graphql"),
        };
        if (!rateLimits.rest && !rateLimits.graphql) {
            throw new Error("GitHub /rate_limit 返回了意外的数据结构");
        }
        return rateLimits;
    }

    async function fetchRestPages(
        url,
        token,
        onPage,
        shouldPause = () => false,
    ) {
        let page = 1;
        let total = 0;
        let hasNextPage = true;
        let rateLimit = null;
        while (hasNextPage) {
            if (shouldPause()) throw createPauseError();
            const separator = url.includes("?") ? "&" : "?";
            const result = await requestRest(
                token,
                `${url}${separator}page=${page}`,
            );
            total += result.items.length;
            rateLimit = result.rateLimit;
            onPage(result.items, page, total, rateLimit);
            hasNextPage = result.hasNextPage;
            page += 1;
        }
        return { total, rateLimit };
    }

    function normalizeRestComment(comment) {
        return {
            author: { login: comment.user?.login || "" },
            authorAssociation: comment.author_association,
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
        };
    }

    function normalizeRestReview(review) {
        return {
            author: { login: review.user?.login || "" },
            authorAssociation: review.author_association,
            createdAt: review.submitted_at,
            submittedAt: review.submitted_at,
            updatedAt: review.updated_at || null,
        };
    }

    function pullNumberFromUrl(url) {
        const number = Number(String(url || "").split("/").pop());
        return Number.isInteger(number) ? number : null;
    }

    async function replaceConnectionFromRest(
        item,
        key,
        url,
        token,
        normalize,
        label,
        usage,
        rateLimits,
        onProgress,
        shouldPause,
    ) {
        const nodes = [];
        await fetchRestPages(
            url,
            token,
            (items, page, total, rateLimit) => {
                usage.restRequests += 1;
                usage.overflowRest += 1;
                nodes.push(...items.map(normalize));
                rateLimits.rest = rateLimit;
                onProgress(
                    `${label}第 ${page} 页完成；累计 ${total} 条`,
                    rateLimit,
                );
            },
            shouldPause,
        );
        item[key] = {
            totalCount: nodes.length,
            pageInfo: { hasNextPage: false },
            nodes,
        };
    }

    async function fetchCompleteInteractions(
        repository,
        token,
        selectedScope,
        pullRequests,
        issues,
        usage,
        rateLimits,
        onProgress,
        shouldPause = () => false,
    ) {
        const owner = encodeURIComponent(repository.owner);
        const name = encodeURIComponent(repository.name);
        const base = `https://api.github.com/repos/${owner}/${name}`;

        for (const pr of pullRequests) {
            if (pr.comments?.pageInfo?.hasNextPage) {
                await replaceConnectionFromRest(
                    pr,
                    "comments",
                    `${base}/issues/${pr.number}/comments?per_page=100`,
                    token,
                    normalizeRestComment,
                    `REST PR #${pr.number} 普通评论`,
                    usage,
                    rateLimits,
                    onProgress,
                    shouldPause,
                );
            }
            if (pr.reviews?.pageInfo?.hasNextPage) {
                await replaceConnectionFromRest(
                    pr,
                    "reviews",
                    `${base}/pulls/${pr.number}/reviews?per_page=100`,
                    token,
                    normalizeRestReview,
                    `REST PR #${pr.number} Reviews`,
                    usage,
                    rateLimits,
                    onProgress,
                    shouldPause,
                );
            }
        }
        for (const issue of issues) {
            if (issue.comments?.pageInfo?.hasNextPage) {
                await replaceConnectionFromRest(
                    issue,
                    "comments",
                    `${base}/issues/${issue.number}/comments?per_page=100`,
                    token,
                    normalizeRestComment,
                    `REST Issue #${issue.number} 评论`,
                    usage,
                    rateLimits,
                    onProgress,
                    shouldPause,
                );
            }
        }

        if (selectedScope === "all") {
            const byNumber = new Map(
                pullRequests.map((pr) => [pr.number, pr]),
            );
            await fetchRestPages(
                `${base}/pulls/comments?sort=created&direction=asc&per_page=100`,
                token,
                (items, page, total, rateLimit) => {
                    usage.restRequests += 1;
                    usage.inlineCommentRest += 1;
                    for (const comment of items) {
                        const pr = byNumber.get(
                            pullNumberFromUrl(comment.pull_request_url),
                        );
                        if (pr) {
                            pr.reviewComments.push(
                                normalizeRestComment(comment),
                            );
                        }
                    }
                    rateLimits.rest = rateLimit;
                    onProgress(
                        `REST 全仓库行内 Review 评论第 ${page} 页完成；累计 ${total} 条`,
                        rateLimit,
                    );
                },
                shouldPause,
            );
        } else {
            for (const pr of pullRequests) {
                await fetchRestPages(
                    `${base}/pulls/${pr.number}/comments?per_page=100`,
                    token,
                    (items, page, total, rateLimit) => {
                        usage.restRequests += 1;
                        usage.inlineCommentRest += 1;
                        pr.reviewComments.push(
                            ...items.map(normalizeRestComment),
                        );
                        rateLimits.rest = rateLimit;
                        onProgress(
                            `REST Open PR #${pr.number} 行内评论第 ${page} 页完成；累计 ${total} 条`,
                            rateLimit,
                        );
                    },
                    shouldPause,
                );
            }
        }
        for (const pr of pullRequests) pr.inlineCommentsComplete = true;
    }

    async function fetchCommitContributors(
        repository,
        token,
        usage,
        rateLimits,
        onProgress,
    ) {
        const owner = encodeURIComponent(repository.owner);
        const name = encodeURIComponent(repository.name);
        const result = await requestRest(
            token,
            `https://api.github.com/repos/${owner}/${name}/stats/contributors`,
            {
                acceptedStatuses: [200, 202, 204],
                expectArray: false,
            },
        );
        usage.restRequests += 1;
        usage.commitStatsRest += 1;
        rateLimits.rest = result.rateLimit;
        const message =
            result.status === 200
                ? `REST Commit 贡献者统计完成；${result.items.length} 位作者`
                : result.status === 202
                  ? "GitHub 正在生成 Commit 统计缓存；本次不自动重试以节省额度"
                  : "仓库没有可用的 Commit 统计";
        onProgress(message, result.rateLimit);
        return {
            entries: result.status === 200 ? result.items : null,
            status: result.status,
        };
    }

    function collectOverflow(pullRequests, issues) {
        const rows = [];
        for (const pr of pullRequests) {
            const fields = [];
            if (pr.comments?.pageInfo?.hasNextPage) fields.push("普通评论");
            if (pr.reviews?.pageInfo?.hasNextPage) fields.push("Reviews");
            if (fields.length) rows.push(`PR #${pr.number} ${fields.join("/")}`);
        }
        for (const issue of issues) {
            const fields = [];
            if (issue.comments?.pageInfo?.hasNextPage) fields.push("评论");
            if (issue.labels?.pageInfo?.hasNextPage) fields.push("标签");
            if (fields.length) {
                rows.push(`Issue #${issue.number} ${fields.join("/")}`);
            }
        }
        return rows;
    }

    async function fetchRepositoryData(
        repository,
        token,
        selectedScope,
        onProgress,
        requestedOptions = DEFAULT_OPTIONS,
        startingRateLimits = null,
        resumeState = null,
        onCheckpoint = () => {},
        shouldPause = () => false,
    ) {
        const selectedOptions = { ...DEFAULT_OPTIONS, ...requestedOptions };
        const checkpointKey = fetchCheckpointKey(
            repository,
            selectedScope,
            selectedOptions,
        );
        const resume =
            resumeState?.version === CHECKPOINT_VERSION &&
            resumeState.key === checkpointKey
                ? resumeState
                : null;
        let pageSize = Math.max(
            MIN_PAGE_SIZE,
            Math.min(MAX_PAGE_SIZE, Number(resume?.pageSize) || MAX_PAGE_SIZE),
        );
        const pullRequests = Array.isArray(resume?.pullRequests)
            ? resume.pullRequests
            : [];
        const issues = Array.isArray(resume?.issues) ? resume.issues : [];
        const rateLimits = {
            graphql:
                startingRateLimits?.graphql ||
                resume?.rateLimits?.graphql ||
                null,
            rest:
                startingRateLimits?.rest || resume?.rateLimits?.rest || null,
        };
        const usage = {
            graphqlPoints: 0,
            graphqlRequests: 0,
            restRequests: 0,
            overflowRest: 0,
            inlineCommentRest: 0,
            commitStatsRest: 0,
            ...(resume?.usage || {}),
        };
        let prCursor = resume?.prCursor || null;
        let issueCursor = resume?.issueCursor || null;
        let fetchPulls = resume ? Boolean(resume.fetchPulls) : true;
        let fetchIssues = resume
            ? Boolean(resume.fetchIssues)
            : selectedOptions.includeIssues;
        let prTotal = resume?.prTotal ?? null;
        let issueTotal = resume
            ? (resume.issueTotal ?? null)
            : selectedOptions.includeIssues
              ? null
              : 0;
        let page = Number(resume?.page) || 0;
        let prPage = Number(resume?.prPage) || 0;
        let issuePage = Number(resume?.issuePage) || 0;
        const combineResources = selectedScope === "open";
        const saveCheckpoint = (cloneGraphqlData = false) => {
            const state = {
                version: CHECKPOINT_VERSION,
                key: checkpointKey,
                repository: { ...repository },
                selectedScope,
                selectedOptions: { ...selectedOptions },
                pageSize,
                pullRequests,
                issues,
                rateLimits: { ...rateLimits },
                usage: { ...usage },
                prCursor,
                issueCursor,
                fetchPulls,
                fetchIssues,
                prTotal,
                issueTotal,
                page,
                prPage,
                issuePage,
            };
            if (cloneGraphqlData) {
                state.pullRequests = JSON.parse(JSON.stringify(pullRequests));
                state.issues = JSON.parse(JSON.stringify(issues));
            }
            onCheckpoint(state);
        };
        const stopIfPaused = () => {
            if (!shouldPause()) return;
            saveCheckpoint();
            throw createPauseError();
        };

        saveCheckpoint();
        if (resume) {
            onProgress(
                `恢复读取检查点；已有 PR ${pullRequests.length}/${prTotal ?? "?"}、Issue ${issues.length}/${issueTotal ?? "?"}；从未完成页继续`,
                rateLimits.graphql,
            );
        }

        while (fetchPulls || fetchIssues) {
            stopIfPaused();
            // 全量历史的嵌套评论响应可能很大。Open 通常很小，仍合并为
            // 一次请求；全量模式按 PR、Issue 分开分页，避免 GitHub 网关
            // 返回非 JSON。嵌套互动只预取较小的元数据窗口，溢出数据可用
            // “完整互动”选项补全。
            const requestPulls = fetchPulls;
            const requestIssues =
                fetchIssues && (combineResources || !fetchPulls);
            const requestParts = [];
            if (requestPulls) {
                requestParts.push(
                    `PR 第 ${prPage + 1} 页（${prCursor ? "续页" : "首页"}）`,
                );
            }
            if (requestIssues) {
                requestParts.push(
                    `Issue 第 ${issuePage + 1} 页（${issueCursor ? "续页" : "首页"}）`,
                );
            }
            const requestLabel = requestParts.join(" + ");
            let data;
            let requestSeconds;
            let retryCount = 0;
            while (true) {
                stopIfPaused();
                onProgress(
                    `准备请求 GraphQL ${requestLabel}；对象上限 ${pageSize}/页；每个互动连接上限 ${INTERACTION_PREVIEW_SIZE} 条元数据（不含正文）`,
                    null,
                );
                const requestStartedAt = Date.now();
                try {
                    data = await requestGraphQL(
                        REPOSITORY_QUERY,
                        token,
                        {
                            owner: repository.owner,
                            name: repository.name,
                            prCursor,
                            issueCursor,
                            prStates:
                                selectedScope === "open"
                                    ? ["OPEN"]
                                    : ["OPEN", "CLOSED", "MERGED"],
                            issueStates:
                                selectedScope === "open"
                                    ? ["OPEN"]
                                    : ["OPEN", "CLOSED"],
                            pageSize,
                            fetchPulls: requestPulls,
                            fetchIssues: requestIssues,
                        },
                        {
                            onHeartbeat: (elapsedSeconds) =>
                                onProgress(
                                    `GraphQL ${requestLabel} 请求仍在进行；已等待 ${elapsedSeconds} 秒；${GRAPHQL_WATCHDOG_MS / 1000} 秒无回调将中止并自动重试`,
                                    null,
                                ),
                        },
                    );
                    requestSeconds = (
                        (Date.now() - requestStartedAt) /
                        1000
                    ).toFixed(1);
                    break;
                } catch (error) {
                    const seconds = (
                        (Date.now() - requestStartedAt) /
                        1000
                    ).toFixed(1);
                    const failure = `GraphQL ${requestLabel}失败；对象上限 ${pageSize}/页；耗时 ${seconds} 秒`;
                    const nextPageSize = Math.max(
                        MIN_PAGE_SIZE,
                        pageSize - PAGE_SIZE_STEP,
                    );
                    const retryable = isRetryableGraphqlFailure(error);
                    if (!retryable) {
                        saveCheckpoint();
                        throw new Error(
                            `${failure}；未自动重试：该错误不是可降级重试的临时 GraphQL 错误；${error.message || String(error)}`,
                        );
                    }

                    retryCount += 1;
                    const previousPageSize = pageSize;
                    pageSize = nextPageSize;
                    saveCheckpoint();
                    const pageSizeMessage =
                        previousPageSize === pageSize
                            ? `保持最小对象上限 ${pageSize}/页`
                            : `对象上限 ${previousPageSize} → ${pageSize}/页`;
                    onProgress(
                        `${failure}；原因：${error.message || String(error)}；临时错误不进行额度复核；${pageSizeMessage}；第 ${retryCount} 次自动重试`,
                        null,
                    );
                }
            }
            if (!data?.repository) {
                saveCheckpoint();
                throw new Error("仓库不存在，或 Token 没有读取权限");
            }
            if (requestPulls) {
                prPage += 1;
                const connection = data.repository.pullRequests;
                prTotal ??= connection.totalCount;
                for (const node of connection.nodes) {
                    node.reviewComments = [];
                    node.inlineCommentsComplete = false;
                    pullRequests.push(node);
                }
                prCursor = connection.pageInfo.endCursor;
                fetchPulls = connection.pageInfo.hasNextPage;
            }
            if (requestIssues) {
                issuePage += 1;
                const connection = data.repository.issues;
                issueTotal ??= connection.totalCount;
                issues.push(...connection.nodes);
                issueCursor = connection.pageInfo.endCursor;
                fetchIssues = connection.pageInfo.hasNextPage;
            }
            page += 1;
            const rateLimit = { ...data.rateLimit, resource: "graphql" };
            usage.graphqlPoints += rateLimit.cost;
            usage.graphqlRequests += 1;
            rateLimits.graphql = rateLimit;
            const progress = [];
            if (requestPulls) {
                progress.push(
                    `PR ${pullRequests.length}/${prTotal ?? "?"}`,
                );
            }
            if (requestIssues) {
                progress.push(`Issue ${issues.length}/${issueTotal ?? "?"}`);
            }
            const progressCurrent =
                requestPulls && requestIssues
                    ? pullRequests.length + issues.length
                    : requestPulls
                      ? pullRequests.length
                      : issues.length;
            const progressTotal =
                requestPulls && requestIssues
                    ? (prTotal || 0) + (issueTotal || 0)
                    : requestPulls
                      ? prTotal
                      : issueTotal;
            onProgress(
                `GraphQL 第 ${page} 次请求完成；对象上限 ${pageSize}/页；${progress.join("，")}；cost ${rateLimit.cost}；耗时 ${requestSeconds} 秒`,
                rateLimit,
                {
                    value: progressTotal
                        ? (100 * progressCurrent) / progressTotal
                        : null,
                    label: `读取数据：${progress.join("，")}`,
                },
            );
            const nextPageSize = Math.min(
                MAX_PAGE_SIZE,
                pageSize + PAGE_SIZE_STEP,
            );
            if ((fetchPulls || fetchIssues) && nextPageSize !== pageSize) {
                onProgress(
                    `本页成功；后续页对象上限 ${pageSize} → ${nextPageSize}/页`,
                    null,
                );
                pageSize = nextPageSize;
            }
            saveCheckpoint();
            stopIfPaused();
        }

        if (selectedOptions.completeInteractions) {
            // 保留一份未被 REST 补全过程修改的 GraphQL 检查点；如果 REST
            // 中断，继续时从干净数据重新补全，避免重复追加行内评论。
            saveCheckpoint(true);
            onProgress(
                "GraphQL 基础数据读取完成；开始读取完整互动数据",
                null,
                { value: null, label: "读取数据：补全评论与 Review" },
            );
            await fetchCompleteInteractions(
                repository,
                token,
                selectedScope,
                pullRequests,
                issues,
                usage,
                rateLimits,
                onProgress,
                shouldPause,
            );
            stopIfPaused();
        }

        let commitResult = { entries: null, status: null };
        if (selectedOptions.includeCommits) {
            stopIfPaused();
            onProgress("开始读取 Commit 贡献者统计", null, {
                value: null,
                label: "读取数据：Commit 贡献者统计",
            });
            commitResult = await fetchCommitContributors(
                repository,
                token,
                usage,
                rateLimits,
                onProgress,
            );
            stopIfPaused();
        }

        // ponytail: exact inline comments are opt-in because Open scope costs at
        // least one REST request per PR; exact per-commit history is intentionally
        // replaced by GitHub's single cached contributor-statistics endpoint.
        return {
            coverage: {
                fullHistory: selectedScope === "all",
                issues: selectedOptions.includeIssues,
                completeInteractions: selectedOptions.completeInteractions,
                inlineComments: selectedOptions.completeInteractions,
                commitStatus: commitResult.status,
            },
            raw: {
                repository,
                scope: selectedScope,
                options: selectedOptions,
                fetchedAt: new Date().toISOString(),
                pullRequests,
                issues,
                commitContributors: commitResult.entries,
            },
            rateLimits,
            usage,
        };
    }

    function yieldToUi() {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    async function analyzeRepositoryData(fetchedData, onProgress = () => {}) {
        const pullRequests = fetchedData.raw.pullRequests || [];
        const issues = fetchedData.raw.issues || [];
        const commitEntries = fetchedData.raw.commitContributors;
        const rows = [];
        const issueRows = [];
        const totalItems = pullRequests.length + issues.length;
        const analysisNow = Date.now();
        let processed = 0;

        const report = async (message, value) => {
            onProgress(message, { value, label: message });
            await yieldToUi();
        };
        const itemProgress = () =>
            totalItems ? (80 * processed) / totalItems : 80;

        await report(
            `本地分析开始；待处理 ${pullRequests.length} 个 PR、${issues.length} 个 Issue；此阶段不调用 GitHub API`,
            0,
        );
        for (let index = 0; index < pullRequests.length; index += 1) {
            rows.push(analyzePullRequest(pullRequests[index], analysisNow));
            processed += 1;
            if (
                (index + 1) % ANALYSIS_BATCH_SIZE === 0 ||
                index + 1 === pullRequests.length
            ) {
                const value = itemProgress();
                await report(
                    `本地分析 PR ${index + 1}/${pullRequests.length}；总进度 ${value.toFixed(1)}%`,
                    value,
                );
            }
        }
        for (let index = 0; index < issues.length; index += 1) {
            issueRows.push(analyzeIssue(issues[index], analysisNow));
            processed += 1;
            if (
                (index + 1) % ANALYSIS_BATCH_SIZE === 0 ||
                index + 1 === issues.length
            ) {
                const value = itemProgress();
                await report(
                    `本地分析 Issue ${index + 1}/${issues.length}；总进度 ${value.toFixed(1)}%`,
                    value,
                );
            }
        }

        await report("正在聚合贡献者活跃度与身份…", 85);
        const contributorStats = buildContributorStatistics(
            pullRequests,
            issues,
            commitEntries,
            fetchedData.coverage.fullHistory,
        );
        await report("贡献者聚合完成；正在汇总 Commit 分布…", 95);
        const commitStats = analyzeCommitContributors(commitEntries);
        onProgress("本地指标计算完成；准备生成统计图表…", {
            value: 98,
            label: "本地指标计算完成",
        });

        return {
            ...fetchedData,
            rows,
            issueRows,
            contributors: contributorStats,
            commitStats,
            overflow: collectOverflow(pullRequests, issues),
        };
    }

    function escapeHtml(value) {
        return String(value ?? "").replace(
            /[&<>"']/g,
            (character) =>
                ({
                    "&": "&amp;",
                    "<": "&lt;",
                    ">": "&gt;",
                    '"': "&quot;",
                    "'": "&#39;",
                })[character],
        );
    }

    function formatDate(isoDate) {
        if (!isoDate || !Number.isFinite(Date.parse(isoDate))) return "—";
        return new Intl.DateTimeFormat("zh-CN", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        }).format(new Date(isoDate));
    }

    function relativeTime(isoDate) {
        if (!isoDate || !Number.isFinite(Date.parse(isoDate))) return "—";
        const seconds = Math.max(
            0,
            Math.floor((Date.now() - Date.parse(isoDate)) / 1000),
        );
        if (seconds < 60) return `${seconds} 秒前`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
        return `${Math.floor(seconds / 86400)} 天前`;
    }

    function latestReplyHtml(event, compact = false) {
        if (!event) return "—";
        const link = `<a href="${escapeHtml(event.url)}" target="_blank" rel="noopener">#${event.number}${
            compact ? "" : ` ${escapeHtml(event.title)}`
        }</a>`;
        return `${link}<span>${escapeHtml(event.login)} · ${formatDate(
            event.at,
        )}（${relativeTime(event.at)}）</span>`;
    }

    function countAndRate(count, total) {
        return `${count} / ${total}（${rate(count, total)}）`;
    }

    function formatDuration(hours) {
        if (!Number.isFinite(hours)) return "—";
        if (hours < 1) return `${Math.round(hours * 60)} 分钟`;
        if (hours < 48) return `${hours.toFixed(1)} 小时`;
        return `${(hours / 24).toFixed(1)} 天`;
    }

    function cardsMarkup(cards) {
        return cards
            .map(
                ([label, value, className = ""]) => `
                    <article class="card ${className}">
                      <span>${escapeHtml(label)}</span>
                      <strong>${value}</strong>
                    </article>
                `,
            )
            .join("");
    }

    function barChartMarkup(title, rows, maximum = 100) {
        const scale = Number.isFinite(maximum) && maximum > 0 ? maximum : 1;
        return `
            <article class="chart-card">
              <h4>${escapeHtml(title)}</h4>
              <div class="chart-bars">
                ${rows
                    .map(([label, value, display = value, tone = "blue"]) => {
                        const numeric = Number(value);
                        const width = Math.max(
                            0,
                            Math.min(
                                100,
                                (100 * (Number.isFinite(numeric) ? numeric : 0)) /
                                    scale,
                            ),
                        );
                        const safeTone = CHART_COLORS[tone] ? tone : "blue";
                        const ariaLabel = `${label} ${display}`;
                        return `
                          <div class="chart-row" role="img" aria-label="${escapeHtml(ariaLabel)}">
                            <div class="chart-label"><span>${escapeHtml(label)}</span><strong>${escapeHtml(display)}</strong></div>
                            <div class="chart-track"><span class="chart-fill tone-${safeTone}" style="width:${width.toFixed(2)}%"></span></div>
                          </div>
                        `;
                    })
                    .join("")}
              </div>
            </article>
        `;
    }

    function donutChartMarkup(title, rows) {
        const items = rows.map(
            ([label, value, display = value, tone = "blue"]) => ({
                label,
                value: Math.max(0, Number(value) || 0),
                display,
                tone: CHART_COLORS[tone] ? tone : "blue",
            }),
        );
        const total = items.reduce((sum, item) => sum + item.value, 0);
        let offset = 0;
        const positiveItems = items.filter((item) => item.value > 0);
        const segments = positiveItems.map((item, index) => {
            const start = offset;
            offset += (100 * item.value) / total;
            const end = index === positiveItems.length - 1 ? 100 : offset;
            return `${CHART_COLORS[item.tone]} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
        });
        const background = segments.length
            ? `conic-gradient(${segments.join(", ")})`
            : "var(--muted-bg)";
        const ariaLabel = `${title}；${items
            .map((item) => `${item.label} ${item.display}`)
            .join("，")}`;
        return `
            <article class="chart-card">
              <h4>${escapeHtml(title)}</h4>
              <div class="donut-layout">
                <div class="donut-chart" role="img" aria-label="${escapeHtml(ariaLabel)}" style="background:${background}">
                  <div class="donut-total"><strong>${escapeHtml(total)}</strong><span>总计</span></div>
                </div>
                <div class="donut-legend">
                  ${items
                      .map(
                          (item) => `
                            <div class="donut-legend-row">
                              <i class="tone-${item.tone}"></i>
                              <span>${escapeHtml(item.label)}</span>
                              <strong>${escapeHtml(item.display)}</strong>
                            </div>
                          `,
                      )
                      .join("")}
                </div>
              </div>
            </article>
        `;
    }

    function lineChartMarkup(
        title,
        labels,
        series,
        yAxisLabel = "数量",
        dailyAxis = false,
        rangeOptions = null,
    ) {
        const safeLabels = labels.map((label) => String(label));
        const normalizeSeries = (sourceLabels, sourceSeries) =>
            (sourceSeries || []).map((item, index) => ({
                label: item.label,
                tone: CHART_COLORS[item.tone] ? item.tone : "blue",
                reference: Boolean(item.reference),
                dash:
                    item.dash ||
                    (item.reference
                        ? REFERENCE_LINE_DASHES[
                              Math.max(0, index - 1) %
                                  REFERENCE_LINE_DASHES.length
                          ]
                        : ""),
                values: sourceLabels.map((_label, valueIndex) => {
                    const value = Number(item.values?.[valueIndex]);
                    return Number.isFinite(value) ? Math.max(0, value) : 0;
                }),
            }));
        const safeSeries = normalizeSeries(safeLabels, series);
        if (!safeLabels.length || !safeSeries.length) return "";

        const left = 64;
        const chartWidth = 1000;
        const right = chartWidth - 20;
        const top = 15;
        const bottom = 220;
        const chartHeight = 300;
        const height = bottom - top;
        const dataMaximum = Math.max(
            1,
            ...safeSeries.flatMap((item) => item.values),
        );
        const roughStep = Math.max(1, Math.ceil(dataMaximum / 5));
        const magnitude = 10 ** Math.floor(Math.log10(roughStep));
        const normalizedStep = roughStep / magnitude;
        const tickStep =
            (normalizedStep <= 1
                ? 1
                : normalizedStep <= 2
                  ? 2
                  : normalizedStep <= 3
                    ? 3
                    : normalizedStep <= 5
                      ? 5
                      : 10) * magnitude;
        const maximum = Math.ceil(dataMaximum / tickStep) * tickStep;
        const yTicks = Array.from(
            { length: Math.round(maximum / tickStep) + 1 },
            (_item, index) => maximum - index * tickStep,
        );
        const x = (index) =>
            safeLabels.length === 1
                ? (left + right) / 2
                : left + ((right - left) * index) / (safeLabels.length - 1);
        const y = (value) => bottom - (height * value) / maximum;
        const xTickCount = Math.min(
            dailyAxis ? 8 : 12,
            safeLabels.length,
        );
        const labelIndexes = Array.from(
            { length: xTickCount },
            (_item, index) =>
                xTickCount === 1
                    ? 0
                    : Math.round(
                          (index * (safeLabels.length - 1)) /
                              (xTickCount - 1),
                      ),
        ).filter((value, index, all) => all.indexOf(value) === index);
        const showPoints = safeLabels.length <= 120;
        const densitySummary = showPoints
            ? `${safeLabels.length} 个每日数据点`
            : `保留全部 ${safeLabels.length} 个每日数据点，已隐藏圆点标记以减少渲染`;
        const chartSummary = `显示区间 ${safeLabels[0]} 至 ${safeLabels.at(-1)}；${densitySummary}；区间末值：${safeSeries
            .map((item) => `${item.label} ${item.values.at(-1) || 0}`)
            .join("，")}${rangeOptions?.note ? `；${rangeOptions.note}` : ""}`;
        const ariaLabel = `${title}；${chartSummary}`;
        const yAxisMarkup = `
            <line class="line-axis" x1="${left}" y1="${top}" x2="${left}" y2="${bottom}"></line>
            ${yTicks
                .map((value) => {
                    const tickY = y(value);
                    return `<line class="line-tick" x1="${left - 6}" y1="${tickY}" x2="${left}" y2="${tickY}"></line><text class="line-axis-label line-y-label" text-anchor="end" x="${left - 10}" y="${tickY + 5}">${value}</text>`;
                })
                .join("")}
            <text class="line-axis-title" text-anchor="middle" x="-115" y="14" transform="rotate(-90)">${escapeHtml(yAxisLabel)}</text>
        `;
        let rangeMarkup = "";
        if (dailyAxis && rangeOptions?.fullLabels?.length) {
            const fullLabels = rangeOptions.fullLabels.map((label) =>
                String(label),
            );
            const fullSeries = normalizeSeries(
                fullLabels,
                rangeOptions.fullSeries,
            );
            const lastIndex = fullLabels.length - 1;
            const startIndex = Math.max(
                0,
                Math.min(lastIndex, Number(rangeOptions.startIndex) || 0),
            );
            const endIndex = Math.max(
                startIndex,
                Math.min(
                    lastIndex,
                    Number.isFinite(Number(rangeOptions.endIndex))
                        ? Number(rangeOptions.endIndex)
                        : lastIndex,
                ),
            );
            const denominator = Math.max(1, lastIndex);
            const startPercent = (100 * startIndex) / denominator;
            const endPercent =
                fullLabels.length === 1
                    ? 100
                    : (100 * endIndex) / denominator;
            const overviewTop = 5;
            const overviewBottom = 59;
            const overviewMaximum = Math.max(
                1,
                ...fullSeries.flatMap((item) => item.values),
            );
            const overviewX = (index) =>
                fullLabels.length === 1
                    ? 500
                    : (1000 * index) / lastIndex;
            const overviewY = (value) =>
                overviewBottom -
                ((overviewBottom - overviewTop) * value) / overviewMaximum;
            rangeMarkup = `
              <div class="trend-range-panel">
                <div class="trend-range-controls" role="group" aria-label="选择 PR 趋势显示区间">
                  <label><span>开始日期</span><input type="date" data-trend-date="start" min="${escapeHtml(fullLabels[0])}" max="${escapeHtml(fullLabels.at(-1))}" value="${escapeHtml(fullLabels[startIndex])}"></label>
                  <label><span>结束日期</span><input type="date" data-trend-date="end" min="${escapeHtml(fullLabels[0])}" max="${escapeHtml(fullLabels.at(-1))}" value="${escapeHtml(fullLabels[endIndex])}"></label>
                  <button type="button" class="button" data-trend-reset>全部时间</button>
                </div>
                <p class="trend-range-status" data-trend-status aria-live="polite">${escapeHtml(`显示 ${fullLabels[startIndex]} 至 ${fullLabels[endIndex]}，共 ${endIndex - startIndex + 1} 天；本地筛选，不调用 API`)}</p>
                <div class="trend-overview-shell" role="group" aria-label="拖动两个滑块选择日期范围；也可以使用上方日期输入框">
                  <svg class="trend-overview" viewBox="0 0 1000 64" preserveAspectRatio="none" aria-hidden="true">
                    ${fullSeries
                        .map((item) => {
                            const points = item.values
                                .map(
                                    (value, index) =>
                                        `${overviewX(index).toFixed(2)},${overviewY(value).toFixed(2)}`,
                                )
                                .join(" ");
                            return `<polyline style="fill:none;stroke:${CHART_COLORS[item.tone]};stroke-width:2;stroke-dasharray:${item.dash || "none"};vector-effect:non-scaling-stroke" points="${points}"></polyline>`;
                        })
                        .join("")}
                  </svg>
                  <div class="trend-overview-selection" data-trend-selection style="left:${startPercent.toFixed(3)}%;width:${Math.max(0, endPercent - startPercent).toFixed(3)}%" aria-hidden="true"></div>
                  <input class="trend-range trend-range-start" type="range" data-trend-range="start" min="0" max="${lastIndex}" value="${startIndex}" aria-label="选择开始日期">
                  <input class="trend-range trend-range-end" type="range" data-trend-range="end" min="0" max="${lastIndex}" value="${endIndex}" aria-label="选择结束日期">
                </div>
              </div>
            `;
        }
        return `
            <article class="chart-card line-chart-card">
              <h4>${escapeHtml(title)}</h4>
              <div class="line-legend">
                ${safeSeries
                    .map(
                        (item) => `<div class="line-legend-item"><svg class="line-legend-key" viewBox="0 0 28 8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" style="stroke:${CHART_COLORS[item.tone]};stroke-width:3;stroke-dasharray:${item.dash || "none"}"></line></svg><span>${escapeHtml(item.label)}</span><strong>${item.values.at(-1) || 0}</strong></div>`,
                    )
                    .join("")}
              </div>
              <div class="chart-context">
                <p class="chart-summary">${escapeHtml(chartSummary)}</p>
              </div>
              <div class="line-chart-scroll" data-daily-axis="${dailyAxis}" role="region" aria-label="${escapeHtml(`${title}；${chartSummary}`)}">
              <svg class="line-chart" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="${escapeHtml(ariaLabel)}">
                ${yAxisMarkup}
                <line class="line-axis" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"></line>
                ${labelIndexes
                    .map((index) => {
                        const tickX = x(index);
                        const anchor =
                            safeLabels.length === 1
                                ? "middle"
                                : index === 0
                                  ? "start"
                                  : index === safeLabels.length - 1
                                    ? "end"
                                    : "middle";
                        const labelY = dailyAxis ? bottom + 22 : 260;
                        return `<line class="line-tick" x1="${tickX}" y1="${bottom}" x2="${tickX}" y2="${bottom + 6}"></line><text class="line-axis-label line-x-label${dailyAxis ? " line-daily-label" : ""}" text-anchor="${anchor}" x="${tickX}" y="${labelY}">${escapeHtml(safeLabels[index])}</text>`;
                    })
                    .join("")}
                ${safeSeries
                    .map((item, seriesIndex) => {
                        const color = CHART_COLORS[item.tone];
                        if (item.reference) {
                            const value = item.values.at(-1) || 0;
                            return `<line class="line-path line-reference" style="stroke:${color};stroke-width:2;stroke-dasharray:${item.dash}" x1="${left}" y1="${y(value).toFixed(2)}" x2="${right}" y2="${y(value).toFixed(2)}"><title>${escapeHtml(item.label)}：${value}</title></line>`;
                        }
                        const points = item.values
                            .map(
                                (value, index) =>
                                    `${x(index).toFixed(2)},${y(value).toFixed(2)}`,
                            )
                            .join(" ");
                        return `
                          <polyline class="line-path" style="stroke:${color};stroke-width:${seriesIndex === 0 ? 3 : 2.5};stroke-dasharray:${item.dash || "none"}" points="${points}"></polyline>
                          ${
                              showPoints
                                  ? item.values
                                        .map(
                                            (value, index) => `<circle class="line-point" style="fill:${color}" cx="${x(index).toFixed(2)}" cy="${y(value).toFixed(2)}" r="5"><title>${escapeHtml(item.label)} · ${escapeHtml(safeLabels[index])}：${value}</title></circle>`,
                                        )
                                        .join("")
                                  : ""
                          }
                        `;
                    })
                    .join("")}
                <text class="line-axis-title" text-anchor="middle" x="${(left + right) / 2}" y="292">${dailyAxis ? "日期（每日）" : "时间"}</text>
              </svg>
              </div>
              ${rangeMarkup}
            </article>
        `;
    }

    function initializeDailyChart(container, config) {
        const labels = config.labels || [];
        if (!labels.length) {
            container.innerHTML = "";
            return;
        }
        let startIndex = 0;
        let endIndex = labels.length - 1;
        const render = () => {
            const visibleLabels = labels.slice(startIndex, endIndex + 1);
            const visibleSeries = config.series.map((item) => ({
                ...item,
                values: item.values.slice(startIndex, endIndex + 1),
            }));
            container.innerHTML = lineChartMarkup(
                config.title,
                visibleLabels,
                visibleSeries,
                config.yAxisLabel,
                true,
                {
                    fullLabels: labels,
                    fullSeries: config.series,
                    startIndex,
                    endIndex,
                    note: config.note,
                },
            );
            const startRange = container.querySelector(
                '[data-trend-range="start"]',
            );
            const endRange = container.querySelector(
                '[data-trend-range="end"]',
            );
            const startDate = container.querySelector(
                '[data-trend-date="start"]',
            );
            const endDate = container.querySelector(
                '[data-trend-date="end"]',
            );
            const selection = container.querySelector(
                "[data-trend-selection]",
            );
            const status = container.querySelector("[data-trend-status]");
            const updatePreview = (changed) => {
                let nextStart = Number(startRange.value);
                let nextEnd = Number(endRange.value);
                if (nextStart > nextEnd) {
                    if (changed === "start") nextEnd = nextStart;
                    else nextStart = nextEnd;
                }
                startRange.value = String(nextStart);
                endRange.value = String(nextEnd);
                startDate.value = labels[nextStart];
                endDate.value = labels[nextEnd];
                startIndex = nextStart;
                endIndex = nextEnd;
                const denominator = Math.max(1, labels.length - 1);
                const left = (100 * startIndex) / denominator;
                const right =
                    labels.length === 1
                        ? 100
                        : (100 * endIndex) / denominator;
                selection.style.left = `${left}%`;
                selection.style.width = `${Math.max(0, right - left)}%`;
                status.textContent = `显示 ${labels[startIndex]} 至 ${labels[endIndex]}，共 ${endIndex - startIndex + 1} 天；本地筛选，不调用 API`;
            };
            for (const range of [startRange, endRange]) {
                range.addEventListener("input", () =>
                    updatePreview(range.dataset.trendRange),
                );
                range.addEventListener("change", render);
            }
            for (const dateInput of [startDate, endDate]) {
                dateInput.addEventListener("change", () => {
                    const index = labels.indexOf(dateInput.value);
                    if (index < 0) return;
                    if (dateInput.dataset.trendDate === "start") {
                        startIndex = index;
                        if (startIndex > endIndex) endIndex = startIndex;
                    } else {
                        endIndex = index;
                        if (endIndex < startIndex) startIndex = endIndex;
                    }
                    render();
                });
            }
            container
                .querySelector("[data-trend-reset]")
                .addEventListener("click", () => {
                    startIndex = 0;
                    endIndex = labels.length - 1;
                    render();
                });
        };
        render();
    }

    function contributorRole(row) {
        if (row.bot) return "机器人";
        const roles = [];
        if (row.core) roles.push("核心");
        if (row.internal) roles.push("内部");
        if (row.firstTimeContributor) roles.push("首次");
        if (row.recurringExternal) roles.push("持续外部");
        else if (row.external) roles.push("外部");
        return roles.join(" / ") || "其他";
    }

    function renderCostGuide() {
        const issueCount = analysis?.issueRows.length || 0;
        const usage = analysis?.usage || lastUsage;
        const rows = [
            [
                "PR 标题/正文/作者/状态/时间/改动量/stale",
                "主 GraphQL 标量字段",
                "否",
                "0 额外 point",
                "低",
            ],
            [
                `PR 前 ${INTERACTION_PREVIEW_SIZE} 条普通评论/Review 元数据（不含正文）、修改时间、PR commit 数`,
                "主 GraphQL 嵌套连接",
                "否",
                "实际 cost 见日志；与主查询合并",
                "低-中",
            ],
            [
                "行内 Review 评论",
                "REST /pulls/comments 或逐 Open PR",
                "是",
                `实际 ${usage.inlineCommentRest || 0} 请求；Open 完整模式至少 1 请求/PR`,
                "高/可变",
            ],
            [
                `超过前 ${INTERACTION_PREVIEW_SIZE} 条的评论或 Review`,
                "仅对溢出对象 REST 分页",
                "是",
                `实际 ${usage.overflowRest || 0} 请求；每 100 条 1 请求`,
                "可变",
            ],
            [
                `Issue 基础字段、标签、关闭 PR、前 ${INTERACTION_PREVIEW_SIZE} 条评论元数据（不含正文）`,
                "与 PR 主 GraphQL 合并",
                "模块可选",
                `实际 cost 见日志；本次 ${issueCount} 个`,
                "低-中",
            ],
            [
                "贡献者最近活跃、PR/评论/Review 数和身份",
                "从已采集事件聚合",
                "否",
                "0 请求；完整度取决于范围与互动开关",
                "低",
            ],
            [
                "统计指标与图表",
                "全部原始数据读取完成后本地分批分析",
                "否",
                "0 API；每 50 条更新进度",
                "低",
            ],
            [
                "Commit 时间与作者分布",
                "REST /stats/contributors",
                "是",
                `实际 ${usage.commitStatsRest || 0} 请求`,
                "低",
            ],
            [
                "REST/GraphQL 当前额度",
                "REST /rate_limit",
                "按需及失败诊断",
                "0 主额度；可能计入次级限流，不轮询",
                "低",
            ],
            [
                "逐条 Commit 的精确时间、匿名作者和 merge commit",
                "未启用：需完整 Commit 分页",
                "是",
                "约 1 REST 请求 / 100 commits",
                "很高",
            ],
        ];
        ui.costTable.innerHTML = `
            <caption class="sr-only">信息来源与 GitHub API 成本</caption>
            <thead><tr><th scope="col">信息</th><th scope="col">来源</th><th scope="col">额外查询</th><th scope="col">成本</th><th scope="col">评价</th></tr></thead>
            <tbody>${rows
                .map(
                    (row) =>
                        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
                )
                .join("")}</tbody>
        `;
    }

    function render() {
        if (!analysis) return;
        const summary = summarizePullRequests(analysis.rows, scope);
        const isOpen = scope === "open";
        const total = summary.total.count;
        const completeReplies = analysis.coverage.completeInteractions;
        const fetchedAt = analysis.raw.fetchedAt;
        ui.snapshot.hidden = false;
        ui.snapshot.innerHTML = `
            <strong>非实时数据快照</strong>
            <span><b>读取时间</b><time datetime="${escapeHtml(fetchedAt)}">${formatDate(fetchedAt)}</time></span>
            <span><b>显示范围</b>${isOpen ? "仅 Open" : "全部历史"}</span>
            <span><b>已读取</b>PR ${analysis.rows.length} · Issue ${analysis.issueRows.length}</span>
            <span class="snapshot-coverage" data-complete="${completeReplies}"><b>回复覆盖</b>${completeReplies ? "完整互动" : "基础元数据，回复率可能偏低"}</span>
        `;
        const rateRow = (label, value, denominator, tone = "blue") => [
            label,
            percentage(value, denominator),
            countAndRate(value, denominator),
            tone,
        ];
        const cards = isOpen
            ? [
                  ["Open PR", total, "key"],
                  [
                      "提交者回复率",
                      rate(summary.total.submitterReplied, total),
                  ],
                  [
                      "维护者回复率",
                      rate(summary.total.maintainerReplied, total),
                      "key",
                  ],
                  ["30 天 stale", countAndRate(summary.total.stale30, total)],
                  ["90 天 stale", countAndRate(summary.total.stale90, total)],
                  [
                      "首次维护者回复中位数",
                      formatDuration(
                          summary.total.medianFirstMaintainerResponseHours,
                      ),
                  ],
                  [
                      "维护者最近回复",
                      latestReplyHtml(summary.total.latestMaintainerReply, true),
                      "latest",
                  ],
              ]
            : [
                  ["PR", total, "key"],
                  ["总体合并率", rate(summary.total.merged, total), "key"],
                  [
                      "提交者回复率",
                      rate(summary.total.submitterReplied, total),
                  ],
                  [
                      "维护者回复率",
                      rate(summary.total.maintainerReplied, total),
                      "key",
                  ],
                  [
                      "首次维护者回复中位数",
                      formatDuration(
                          summary.total.medianFirstMaintainerResponseHours,
                      ),
                  ],
                  [
                      "维护者最近回复",
                      latestReplyHtml(summary.total.latestMaintainerReply, true),
                      "latest",
                  ],
              ];

        ui.cards.innerHTML = cardsMarkup(cards);
        const prTrend = buildPullRequestTrend(analysis.rows, scope);
        initializeDailyChart(ui.prCharts, {
            title: "Pull Request 状态趋势",
            labels: prTrend.labels,
            series: prTrend.series,
            yAxisLabel: "PR 数量",
            note: prTrend.note,
        });

        const mergeHeader = isOpen
            ? ""
            : '<th scope="col">已合并 / 合并率</th>';
        const prStats = summary.total;
        const denominator = prStats.count;
        ui.table.innerHTML = `
            <caption class="sr-only">Pull Request 核心统计</caption>
            <thead>
              <tr>
                <th scope="col">PR 数</th>
                ${mergeHeader}
                <th scope="col">提交者回复率</th>
                <th scope="col">维护者回复率</th>
                <th scope="col">30 天 stale</th>
                <th scope="col">首次维护者回复中位数</th>
                <th scope="col">维护者最近回复时间</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>${denominator}</td>
                ${
                    isOpen
                        ? ""
                        : `<td>${prStats.merged} / ${denominator}（${rate(
                              prStats.merged,
                              denominator,
                          )}）</td>`
                }
                <td>${prStats.submitterReplied} / ${denominator}（${rate(
                    prStats.submitterReplied,
                    denominator,
                )}）</td>
                <td>${prStats.maintainerReplied} / ${denominator}（${rate(
                    prStats.maintainerReplied,
                    denominator,
                )}）</td>
                <td>${prStats.stale30} / ${denominator}（${rate(
                    prStats.stale30,
                    denominator,
                )}）</td>
                <td>${formatDuration(
                    prStats.medianFirstMaintainerResponseHours,
                )}</td>
                <td class="reply">${latestReplyHtml(
                    prStats.latestMaintainerReply,
                )}</td>
              </tr>
            </tbody>
        `;

        ui.issueSection.hidden = !analysis.coverage.issues;
        if (analysis.coverage.issues) {
            const issues = summarizeIssues(analysis.issueRows, scope);
            ui.issueCards.innerHTML = cardsMarkup([
                [isOpen ? "Open Issue" : "Issue", issues.count, "key"],
                [
                    "维护者回复率",
                    rate(issues.maintainerReplied, issues.count),
                    "key",
                ],
                ["无人回复率", rate(issues.noResponse, issues.count)],
                ["30 天 stale", countAndRate(issues.stale30, issues.count)],
                ["首次回复中位数", formatDuration(issues.medianFirstResponseHours)],
                [
                    "首次维护者回复中位数",
                    formatDuration(issues.medianFirstMaintainerResponseHours),
                ],
                ["解决时间中位数", formatDuration(issues.medianResolutionHours)],
                ["由 PR 关闭", countAndRate(issues.closedByPr, issues.closed)],
                [
                    "维护者最近回复",
                    latestReplyHtml(issues.latestMaintainerReply, true),
                    "latest",
                ],
            ]);
            const issueResponseRows = [
                rateRow(
                    "维护者已回复",
                    issues.maintainerReplied,
                    issues.count,
                    "green",
                ),
                rateRow("无人回复", issues.noResponse, issues.count, "red"),
                rateRow("30 天 stale", issues.stale30, issues.count, "orange"),
                rateRow("90 天 stale", issues.stale90, issues.count, "purple"),
            ];
            if (!isOpen) {
                issueResponseRows.push(
                    rateRow(
                        "由 PR 关闭",
                        issues.closedByPr,
                        issues.closed,
                        "blue",
                    ),
                );
            }
            const categoryRows = [
                ["Bug", issues.categories.bug, issues.categories.bug, "red"],
                [
                    "Feature",
                    issues.categories.feature,
                    issues.categories.feature,
                    "blue",
                ],
                ["Docs", issues.categories.docs, issues.categories.docs, "purple"],
                [
                    "Good first",
                    issues.categories.goodFirst,
                    issues.categories.goodFirst,
                    "green",
                ],
                [
                    "Help wanted",
                    issues.categories.helpWanted,
                    issues.categories.helpWanted,
                    "orange",
                ],
            ];
            ui.issueCharts.innerHTML = [
                barChartMarkup("响应与健康", issueResponseRows),
                barChartMarkup(
                    "Issue 分类",
                    categoryRows,
                    Math.max(1, ...categoryRows.map((row) => row[1])),
                ),
            ].join("");
            ui.issueTable.innerHTML = `
                <caption class="sr-only">Issue 分类统计</caption>
                <thead><tr><th scope="col">Bug</th><th scope="col">Feature</th><th scope="col">Docs</th><th scope="col">Good first issue</th><th scope="col">Help wanted</th></tr></thead>
                <tbody><tr>
                  <td>${issues.categories.bug}</td>
                  <td>${issues.categories.feature}</td>
                  <td>${issues.categories.docs}</td>
                  <td>${issues.categories.goodFirst}</td>
                  <td>${issues.categories.helpWanted}</td>
                </tr></tbody>
            `;
        }

        const contributorSummary = analysis.contributors;
        ui.contributorCards.innerHTML = cardsMarkup([
            ["代码贡献者", contributorSummary.count, "key"],
            ["近 30 天活跃", contributorSummary.active30, "key"],
            ["近 90 天活跃", contributorSummary.active90],
            ["外部贡献者", contributorSummary.external],
            ["持续外部贡献者", contributorSummary.recurringExternal],
            ["内部成员", contributorSummary.internal],
            ["核心贡献者", contributorSummary.core],
            [
                analysis.coverage.fullHistory
                    ? "首次贡献者"
                    : "Open 中首次贡献者",
                contributorSummary.firstTime,
            ],
        ]);
        const contributorAffiliationRows = [
            [
                "外部贡献者",
                contributorSummary.external,
                countAndRate(
                    contributorSummary.external,
                    contributorSummary.count,
                ),
                "blue",
            ],
            [
                "内部成员",
                contributorSummary.internal,
                countAndRate(
                    contributorSummary.internal,
                    contributorSummary.count,
                ),
                "green",
            ],
        ];
        const contributorStructureRows = [
            rateRow(
                "持续外部",
                contributorSummary.recurringExternal,
                contributorSummary.count,
                "purple",
            ),
            rateRow(
                "核心贡献者",
                contributorSummary.core,
                contributorSummary.count,
                "orange",
            ),
            rateRow(
                analysis.coverage.fullHistory ? "首次贡献者" : "Open 中首次",
                contributorSummary.firstTime,
                contributorSummary.count,
                "gray",
            ),
        ];
        const contributorActivityRows = [
            rateRow(
                "近 30 天",
                contributorSummary.active30,
                contributorSummary.count,
                "green",
            ),
            rateRow(
                "近 90 天",
                contributorSummary.active90,
                contributorSummary.count,
                "blue",
            ),
            rateRow(
                "近 365 天",
                contributorSummary.active365,
                contributorSummary.count,
                "purple",
            ),
        ];
        ui.contributorCharts.innerHTML = [
            donutChartMarkup("代码贡献者归属", contributorAffiliationRows),
            barChartMarkup("代码贡献者角色（可重叠）", contributorStructureRows),
            barChartMarkup("最近活跃", contributorActivityRows),
        ].join("");
        ui.contributorTable.innerHTML = `
            <caption class="sr-only">代码贡献者明细</caption>
            <thead><tr><th scope="col">代码贡献者</th><th scope="col">最近活跃</th><th scope="col">角色</th><th scope="col">PR / 合并</th><th scope="col">Issue</th><th scope="col">评论</th><th scope="col">Review</th><th scope="col">Commit</th></tr></thead>
            <tbody>${contributorSummary.rows
                .slice(0, 25)
                .map(
                    (row) => `<tr>
                      <td>${escapeHtml(row.login)}</td>
                      <td>${formatDate(row.lastActivityAt)}</td>
                      <td>${escapeHtml(contributorRole(row))}</td>
                      <td>${row.prCount} / ${row.mergedPrCount}</td>
                      <td>${row.issueCount}</td>
                      <td>${row.commentCount}</td>
                      <td>${row.reviewCount}</td>
                      <td>${row.commitCount}</td>
                    </tr>`,
                )
                .join("")}</tbody>
        `;

        ui.commitSection.hidden = !analyzedOptions?.includeCommits;
        if (analyzedOptions?.includeCommits) {
            const commits = analysis.commitStats;
            if (commits) {
                ui.commitCards.innerHTML = cardsMarkup([
                    ["统计作者 Commit", commits.totalCommits, "key"],
                    ["作者数", commits.contributorCount, "key"],
                    ["Top 1 占比", rate(commits.authors[0]?.total || 0, commits.totalCommits)],
                    ["Top 3 占比", `${(commits.top3Share * 100).toFixed(2)}%`],
                    ["Top 5 占比", `${(commits.top5Share * 100).toFixed(2)}%`],
                    ["最近活跃周", formatDate(commits.lastActiveWeek)],
                ]);
                const monthlyLabels = commits.monthly.map(([month]) => month);
                const monthlySeries = [
                    {
                        label: "Commit 数",
                        tone: "blue",
                        values: commits.monthly.map(([, count]) => count),
                    },
                ];
                const authorRows = commits.authors
                    .slice(0, 8)
                    .map((row, index) => [
                        row.login,
                        row.total,
                        `${row.total}（${rate(row.total, commits.totalCommits)}）`,
                        ["green", "blue", "purple", "orange"][index % 4],
                    ]);
                ui.commitCharts.innerHTML = [
                    monthlyLabels.length
                        ? lineChartMarkup(
                              "最近 12 个月 Commit 趋势",
                              monthlyLabels,
                              monthlySeries,
                              "Commit 数量",
                          )
                        : "",
                    authorRows.length
                        ? barChartMarkup(
                              "Top Commit 作者",
                              authorRows,
                              Math.max(1, ...authorRows.map((row) => row[1])),
                          )
                        : "",
                ].join("");
                ui.commitTable.innerHTML = `
                    <caption class="sr-only">Commit 作者明细</caption>
                    <thead><tr><th scope="col">作者</th><th scope="col">Commit</th><th scope="col">占比</th></tr></thead>
                    <tbody>${commits.authors
                        .slice(0, 20)
                        .map(
                            (row) => `<tr><td>${escapeHtml(row.login)}</td><td>${row.total}</td><td>${rate(row.total, commits.totalCommits)}</td></tr>`,
                        )
                        .join("")}</tbody>
                `;
            } else {
                ui.commitCards.innerHTML = cardsMarkup([
                    [
                        "Commit 统计",
                        analysis.coverage.commitStatus === 202
                            ? "GitHub 正在生成缓存，请稍后重新分析"
                            : "无可用数据",
                        "wide",
                    ],
                ]);
                ui.commitCharts.innerHTML = "";
                ui.commitTable.innerHTML = "";
            }
        }

        renderCostGuide();
        ui.export.disabled = false;

        const warnings = [];
        if (!analysis.coverage.inlineComments) {
            warnings.push("未取行内 Review 评论，回复率可能是下限");
        }
        if (overflowItems.length) {
            warnings.push(
                `${overflowItems.slice(0, 8).join("、")} 超过默认预取 ${INTERACTION_PREVIEW_SIZE} 条；启用“完整互动”可补全`,
            );
        }
        if (!analysis.coverage.fullHistory) {
            warnings.push("贡献者活动计数只覆盖 Open 对象；首次身份使用 GitHub 关联字段");
        }
        const warning = warnings.length ? `；覆盖说明：${warnings.join("；")}` : "";
        const quotas = formatRateLimits();
        const rateLimit = quotas
            ? `；GitHub /rate_limit 实时额度：${quotas}`
            : "；GitHub /rate_limit 实时额度：查询失败";
        const usage = `；本次脚本数据请求（本地计数，不是账户额度）：GraphQL ${lastUsage.graphqlPoints} points / ${lastUsage.graphqlRequests} 次，计费 REST ${lastUsage.restRequests} 次`;
        setStatus(
            `已分析 ${analysis.rows.length} 个 PR、${analysis.issueRows.length} 个 Issue；当前显示 ${total} 个 PR${warning}${usage}${rateLimit}`,
            "success",
        );
    }

    function setStatus(message, type = "") {
        ui.status.textContent = message;
        ui.status.dataset.type = type;
        const time = new Date().toLocaleTimeString("zh-CN", {
            hour12: false,
        });
        ui.log.append(document.createTextNode(`[${time}] ${message}\n`));
        ui.log.scrollTop = ui.log.scrollHeight;
    }

    function setProgress(value, label) {
        ui.progressWrap.hidden = false;
        ui.progressLabel.textContent = label;
        if (!Number.isFinite(value)) {
            ui.progress.removeAttribute("value");
            ui.progressPercent.textContent = "进行中";
            return;
        }
        const normalized = Math.max(0, Math.min(100, value));
        ui.progress.value = normalized;
        ui.progressPercent.textContent = `${normalized.toFixed(1)}%`;
    }

    function setLoading(value) {
        loading = value;
        ui.panel.setAttribute("aria-busy", String(value));
        ui.analyze.disabled = value;
        ui.pause.disabled = !value || pauseRequested;
        if (!value) ui.pause.textContent = "暂停";
        ui.refreshRateLimits.disabled = value;
        ui.scopeAll.disabled = value;
        ui.scopeOpen.disabled = value;
        ui.includeIssues.disabled = value;
        ui.includeCommits.disabled = value;
        ui.completeInteractions.disabled = value;
        ui.export.disabled = value || !analysis;
        const canResume =
            !value &&
            currentRepository &&
            compatibleFetchCheckpoint(
                currentRepository,
                scope,
                selectedOptions(),
            );
        ui.analyze.textContent = value
            ? "分析中…"
            : canResume
              ? "继续分析"
              : analysis
                ? "重新分析"
                : "开始分析";
    }

    function requestPause() {
        if (!loading || pauseRequested) return;
        pauseRequested = true;
        ui.pause.disabled = true;
        ui.pause.textContent = "暂停中…";
        setStatus("已请求暂停；当前 API 请求完成并保存检查点后停止");
    }

    function selectedOptions() {
        return {
            includeIssues: ui.includeIssues.checked,
            includeCommits: ui.includeCommits.checked,
            completeInteractions: ui.completeInteractions.checked,
        };
    }

    function saveOptions() {
        clearFetchCheckpoint();
        GM_setValue(OPTIONS_KEY, selectedOptions());
        ui.analyze.textContent = analysis ? "重新分析" : "开始分析";
        if (analysis) {
            setStatus("分析选项已改变；点击“重新分析”后生效");
        }
        renderCostGuide();
    }

    function resetOutput() {
        for (const element of [
            ui.cards,
            ui.prCharts,
            ui.table,
            ui.issueCards,
            ui.issueCharts,
            ui.issueTable,
            ui.contributorCards,
            ui.contributorCharts,
            ui.contributorTable,
            ui.commitCards,
            ui.commitCharts,
            ui.commitTable,
        ]) {
            element.innerHTML = "";
        }
        ui.issueSection.hidden = true;
        ui.commitSection.hidden = true;
        ui.snapshot.hidden = true;
        ui.snapshot.innerHTML = "";
        ui.progressWrap.hidden = true;
        ui.export.disabled = true;
    }

    async function refreshRateLimits() {
        if (loading) return;
        const token = String(GM_getValue(TOKEN_KEY, "")).trim();
        if (!token) {
            ui.settings.open = true;
            setStatus("请先在 Token 设置中保存 GitHub Token", "error");
            return;
        }
        ui.refreshRateLimits.disabled = true;
        ui.analyze.disabled = true;
        setStatus("正在通过 GitHub /rate_limit 查询额度…");
        try {
            lastRateLimits = await fetchRateLimits(token);
            setStatus(
                `GitHub 实时额度查询完成（不消耗 REST 主额度）；${formatRateLimits()}`,
                "success",
            );
        } catch (error) {
            setStatus(
                `额度查询失败；${error.message || String(error)}`,
                "error",
            );
        } finally {
            ui.refreshRateLimits.disabled = false;
            ui.analyze.disabled = false;
        }
    }

    async function runAnalysis() {
        if (loading || !currentRepository) return;
        const token = String(GM_getValue(TOKEN_KEY, "")).trim();
        if (!token) {
            ui.settings.open = true;
            setStatus("请先在 Token 设置中保存 GitHub Token", "error");
            return;
        }

        const requestedScope = scope;
        const requestedOptions = selectedOptions();
        if (!fetchCheckpoint) {
            const storedCheckpoint = GM_getValue(CHECKPOINT_KEY, null);
            fetchCheckpoint =
                storedCheckpoint?.version === CHECKPOINT_VERSION
                    ? storedCheckpoint
                    : null;
        }
        const resumeCheckpoint = compatibleFetchCheckpoint(
            currentRepository,
            requestedScope,
            requestedOptions,
        );
        if (!resumeCheckpoint) clearFetchCheckpoint();
        const graphQlStrategy =
            requestedScope === "open"
                ? `合并 PR/Issue GraphQL 自适应分页（初始 ${MAX_PAGE_SIZE}/页，失败 -${PAGE_SIZE_STEP}，成功 +${PAGE_SIZE_STEP}，临时错误始终重试）`
                : `PR/Issue 分离 GraphQL 自适应分页（初始 ${MAX_PAGE_SIZE}/页，失败 -${PAGE_SIZE_STEP}，成功 +${PAGE_SIZE_STEP}，临时错误始终重试）`;
        const strategy = `${graphQlStrategy} + 单次 Commit 统计${
            requestedOptions.completeInteractions
                ? " + 完整互动 REST"
                : "（不扫描行内评论）"
        }`;
        const modules = `模块：Issue ${requestedOptions.includeIssues ? "开" : "关"}，Commit ${requestedOptions.includeCommits ? "开" : "关"}，完整互动 ${requestedOptions.completeInteractions ? "开" : "关"}`;
        lastRateLimits = { graphql: null, rest: null };
        lastUsage = {
            graphqlPoints: 0,
            graphqlRequests: 0,
            restRequests: 0,
            overflowRest: 0,
            inlineCommentRest: 0,
            commitStatsRest: 0,
            ...(resumeCheckpoint?.usage || {}),
        };
        analysis = null;
        analyzedScope = null;
        analyzedOptions = null;
        overflowItems = [];
        pauseRequested = false;
        setLoading(true);
        resetOutput();
        setProgress(null, "读取数据：准备请求 GitHub API");
        setStatus(
            `脚本 v${SCRIPT_VERSION}；${resumeCheckpoint ? "继续读取" : "开始读取"} ${currentRepository.owner}/${currentRepository.name} 的原始数据；范围：${
                requestedScope === "open" ? "仅 Open" : "全部历史"
            }；${resumeCheckpoint ? `已保留 PR ${resumeCheckpoint.pullRequests?.length || 0}/${resumeCheckpoint.prTotal ?? "?"}、Issue ${resumeCheckpoint.issues?.length || 0}/${resumeCheckpoint.issueTotal ?? "?"}；` : ""}低额度策略：${strategy}；${modules}`,
        );
        let baselineRateLimits = null;
        try {
            baselineRateLimits = await fetchRateLimits(token);
            lastRateLimits = baselineRateLimits;
            setStatus(
                `读取前额度基线（通过 /rate_limit 查询，不消耗 REST 主额度）；${formatRateLimits(baselineRateLimits)}`,
            );
        } catch (error) {
            setStatus(
                `读取前额度查询失败，继续读取；${error.message || String(error)}`,
            );
        }
        let phase = "fetch";
        try {
            const fetchedData = await fetchRepositoryData(
                currentRepository,
                token,
                requestedScope,
                (message, rateLimit, progress) => {
                    rememberRateLimit(rateLimit);
                    if (progress) {
                        setProgress(progress.value, progress.label);
                    }
                    setStatus(
                        `${message}${
                            rateLimit
                                ? `；${formatRateLimit(rateLimit)}`
                                : ""
                        }`,
                    );
                },
                requestedOptions,
                baselineRateLimits,
                resumeCheckpoint,
                (checkpoint) => {
                    fetchCheckpoint = checkpoint;
                },
                () => pauseRequested,
            );
            lastUsage = fetchedData.usage;
            setProgress(null, "读取数据：复核 GitHub 实时额度");
            setStatus("原始数据读取完成；正在通过 GitHub /rate_limit 复核实际额度");
            try {
                lastRateLimits = await fetchRateLimits(token);
                fetchedData.rateLimits = lastRateLimits;
                const rateLimitChange = formatRateLimitChange(
                    baselineRateLimits,
                    lastRateLimits,
                );
                setStatus(
                    `GitHub 实时额度复核完成；${formatRateLimits()}${rateLimitChange ? `；${rateLimitChange}` : ""}`,
                );
            } catch (error) {
                lastRateLimits = { graphql: null, rest: null };
                fetchedData.rateLimits = lastRateLimits;
                setStatus(
                    `GitHub 实时额度复核失败；不使用本地累计值代替；${error.message || String(error)}`,
                );
            }
            if (pauseRequested) throw createPauseError();
            ui.pause.disabled = true;
            setProgress(100, "原始数据读取完成");
            setStatus(
                `原始数据读取完成：${fetchedData.raw.pullRequests.length} 个 PR、${fetchedData.raw.issues.length} 个 Issue；所有 GitHub API 请求已结束，开始本地分析`,
                "success",
            );
            await yieldToUi();

            phase = "analysis";
            const result = await analyzeRepositoryData(
                fetchedData,
                (message, progress) => {
                    setProgress(progress.value, progress.label);
                    setStatus(message);
                },
            );
            analysis = result;
            analyzedScope = requestedScope;
            analyzedOptions = requestedOptions;
            overflowItems = result.overflow;
            analysis.rateLimits = lastRateLimits;
            render();
            setProgress(100, "分析与图表生成完成");
            clearFetchCheckpoint();
        } catch (error) {
            const currentProgress = ui.progress.hasAttribute("value")
                ? ui.progress.value
                : 0;
            if (error.paused) {
                let checkpointDetails = "";
                if (fetchCheckpoint) {
                    try {
                        GM_setValue(CHECKPOINT_KEY, fetchCheckpoint);
                        checkpointDetails = `；检查点已保存：PR ${fetchCheckpoint.pullRequests?.length || 0}/${fetchCheckpoint.prTotal ?? "?"}、Issue ${fetchCheckpoint.issues?.length || 0}/${fetchCheckpoint.issueTotal ?? "?"}`;
                    } catch (checkpointError) {
                        checkpointDetails = `；检查点持久化失败，但当前页面仍可继续：${checkpointError.message || String(checkpointError)}`;
                    }
                }
                setProgress(currentProgress, "读取已暂停");
                setStatus(
                    `分析已暂停${checkpointDetails}；点击“继续分析”从未完成页继续`,
                    "success",
                );
                return;
            }
            if (phase === "analysis") {
                let checkpointDetails = "";
                if (fetchCheckpoint) {
                    try {
                        GM_setValue(CHECKPOINT_KEY, fetchCheckpoint);
                        checkpointDetails = "；读取检查点已保存，点击“继续分析”可重试本地分析";
                    } catch (checkpointError) {
                        checkpointDetails = `；检查点持久化失败，但当前页面仍可继续：${checkpointError.message || String(checkpointError)}`;
                    }
                }
                setProgress(currentProgress, "本地分析失败");
                setStatus(
                    `本地分析失败；原始数据已经读取完成，本阶段没有调用 GitHub API；${error.message || String(error)}${checkpointDetails}`,
                    "error",
                );
                return;
            }
            setProgress(currentProgress, "数据读取失败");
            let quotaDetails = "";
            try {
                lastRateLimits = await fetchRateLimits(token);
                const rateLimitChange = formatRateLimitChange(
                    baselineRateLimits,
                    lastRateLimits,
                );
                quotaDetails = `；失败后通过 /rate_limit 查询：${formatRateLimits()}${rateLimitChange ? `；${rateLimitChange}` : ""}`;
            } catch (quotaError) {
                quotaDetails = `；失败后额度查询也失败：${quotaError.message || String(quotaError)}`;
            }
            let checkpointDetails = "";
            if (fetchCheckpoint) {
                try {
                    GM_setValue(CHECKPOINT_KEY, fetchCheckpoint);
                    checkpointDetails = `；读取检查点已保存：PR ${fetchCheckpoint.pullRequests?.length || 0}/${fetchCheckpoint.prTotal ?? "?"}、Issue ${fetchCheckpoint.issues?.length || 0}/${fetchCheckpoint.issueTotal ?? "?"}；点击“继续分析”将从未完成页继续`;
                } catch (checkpointError) {
                    checkpointDetails = `；检查点持久化失败，但当前页面仍可继续：${checkpointError.message || String(checkpointError)}`;
                }
            }
            setStatus(
                `${error.message || String(error)}${quotaDetails}${checkpointDetails}`,
                "error",
            );
        } finally {
            pauseRequested = false;
            setLoading(false);
        }
    }

    function exportAnalysis() {
        if (!analysis) return;
        const payload = {
            ...analysis.raw,
            coverage: analysis.coverage,
            rateLimits: analysis.rateLimits || lastRateLimits,
            usage: analysis.usage,
            derived: {
                pullRequests: analysis.rows,
                pullRequestTrend: buildPullRequestTrend(analysis.rows, scope),
                issues: analysis.issueRows,
                contributors: analysis.contributors,
                commits: analysis.commitStats,
            },
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: "application/json;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${currentRepository.owner}-${currentRepository.name}-github-statistics.json`;
        link.click();
        URL.revokeObjectURL(url);
        setStatus("统计原始数据与派生指标已导出为 JSON", "success");
    }

    function saveToken() {
        const token = ui.token.value.trim();
        if (!token) {
            setStatus("Token 不能为空；如需删除请点击“清除 Token”", "error");
            return;
        }
        clearFetchCheckpoint();
        GM_setValue(TOKEN_KEY, token);
        ui.token.value = "";
        ui.settings.open = false;
        updateTokenState();
        setStatus("Token 已保存；请选择分析选项，然后点击“开始分析”", "success");
    }

    function clearToken() {
        clearFetchCheckpoint();
        GM_deleteValue(TOKEN_KEY);
        ui.token.value = "";
        updateTokenState();
        setStatus("Token 已清除");
    }

    function updateTokenState() {
        const configured = Boolean(
            String(GM_getValue(TOKEN_KEY, "")).trim(),
        );
        ui.tokenState.textContent = configured ? "已配置" : "未配置";
        ui.tokenState.dataset.configured = String(configured);
    }

    function createUi() {
        const host = document.createElement("div");
        host.id = "github-pr-statistics-userscript";
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `
          <style>
            :host {
              color-scheme: light dark;
              --panel-bg: var(--bgColor-default, var(--color-canvas-default, #fff));
              --muted-bg: var(--bgColor-muted, var(--color-canvas-subtle, #f6f8fa));
              --text: var(--fgColor-default, var(--color-fg-default, #1f2328));
              --muted: var(--fgColor-muted, var(--color-fg-muted, #59636e));
              --border: var(--borderColor-default, var(--color-border-default, #d0d7de));
              --accent: var(--fgColor-accent, var(--color-accent-fg, #0969da));
              --chart-blue: #0969da;
              --chart-green: #1a7f37;
              --chart-orange: #9a6700;
              --chart-purple: #8250df;
              --chart-red: #cf222e;
              --chart-gray: #57606a;
              font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            @media (prefers-color-scheme: dark) {
              :host { --chart-blue: #58a6ff; --chart-green: #3fb950; --chart-orange: #d29922; --chart-purple: #bc8cff; --chart-red: #ff7b72; --chart-gray: #8b949e; }
            }
            :host-context([data-color-mode="light"]) { --chart-blue: #0969da; --chart-green: #1a7f37; --chart-orange: #9a6700; --chart-purple: #8250df; --chart-red: #cf222e; --chart-gray: #57606a; }
            :host-context([data-color-mode="dark"]) { --chart-blue: #58a6ff; --chart-green: #3fb950; --chart-orange: #d29922; --chart-purple: #bc8cff; --chart-red: #ff7b72; --chart-gray: #8b949e; }
            [hidden] { display: none !important; }
            .sr-only { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
            button, input { font: inherit; }
            button:focus-visible, input:focus-visible, summary:focus-visible, .line-chart-scroll:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
            #launcher {
              position: fixed;
              right: 22px;
              bottom: 22px;
              z-index: 2147483646;
              padding: 9px 14px;
              border: 1px solid #1f883d;
              border-radius: 8px;
              color: #fff;
              background: #1f883d;
              box-shadow: 0 4px 16px #0003;
              cursor: pointer;
              font-weight: 600;
            }
            #panel {
              position: fixed;
              right: 22px;
              bottom: 70px;
              z-index: 2147483647;
              width: min(1120px, calc(100vw - 44px));
              max-height: calc(100vh - 100px);
              overflow: auto;
              color: var(--text);
              background: var(--panel-bg);
              border: 1px solid var(--border);
              border-radius: 12px;
              box-shadow: 0 12px 40px #0005;
            }
            header {
              position: sticky;
              top: 0;
              z-index: 2;
              display: flex;
              align-items: center;
              gap: 10px;
              padding: 12px 16px;
              background: var(--panel-bg);
              border-bottom: 1px solid var(--border);
            }
            header h2 { flex: 1; margin: 0; font-size: 16px; }
            .button {
              padding: 5px 10px;
              color: var(--text);
              background: var(--muted-bg);
              border: 1px solid var(--border);
              border-radius: 6px;
              cursor: pointer;
            }
            .button.primary { color: #fff; background: #1f883d; border-color: #1f883d; }
            .button:disabled { cursor: wait; opacity: .65; }
            #close { border: 0; background: transparent; font-size: 20px; cursor: pointer; color: var(--muted); }
            main { padding: 14px 16px 18px; }
            .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
            .options { display: flex; gap: 8px 14px; flex-wrap: wrap; margin: 10px 0; padding: 9px 10px; background: var(--muted-bg); border-radius: 8px; }
            .options label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
            .scope { display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
            .scope button { padding: 6px 11px; border: 0; border-right: 1px solid var(--border); background: var(--panel-bg); color: var(--text); cursor: pointer; }
            .scope button:last-child { border-right: 0; }
            .scope button.active { color: #fff; background: var(--accent); }
            #status { margin: 10px 0; color: var(--muted); overflow-wrap: anywhere; }
            #status[data-type="error"] { color: var(--chart-red); }
            #status[data-type="success"] { color: var(--chart-green); }
            #progress-wrap { margin: 8px 0 10px; }
            #progress-head { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 4px; color: var(--muted); font-size: 12px; }
            #progress { width: 100%; height: 12px; accent-color: var(--accent); }
            .snapshot-strip { display: flex; align-items: center; gap: 6px 14px; flex-wrap: wrap; margin: 10px 0 4px; padding: 9px 10px; background: var(--muted-bg); border: 1px solid var(--border); border-radius: 8px; }
            .snapshot-strip > strong { color: var(--text); }
            .snapshot-strip span { display: inline-flex; gap: 5px; color: var(--muted); }
            .snapshot-strip b { color: var(--text); font-weight: 600; }
            .snapshot-coverage[data-complete="false"] { font-weight: 600; }
            #log { max-height: 160px; overflow: auto; margin: 8px 0 0; padding: 8px; color: var(--text); background: var(--muted-bg); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
            .section { margin-top: 18px; }
            .section h3 { margin: 0 0 8px; font-size: 15px; }
            .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 8px; margin: 10px 0; }
            .card { min-width: 0; padding: 10px; background: var(--muted-bg); border: 1px solid var(--border); border-radius: 8px; }
            .card.key { box-shadow: inset 3px 0 var(--accent); }
            .card span { display: block; color: var(--muted); margin-bottom: 4px; }
            .card strong { display: block; font-size: 17px; overflow-wrap: anywhere; }
            .card.latest { grid-column: span 2; }
            .card.latest strong { font-size: 13px; }
            .card.latest strong span { margin-top: 3px; }
            .card.wide { grid-column: 1 / -1; }
            .card.wide strong { font-size: 13px; line-height: 1.55; }
            .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin: 10px 0; }
            .chart-card { min-width: 0; padding: 12px; background: var(--panel-bg); border: 1px solid var(--border); border-radius: 8px; }
            .chart-card h4 { margin: 0 0 10px; font-size: 13px; }
            .chart-row + .chart-row { margin-top: 9px; }
            .chart-label { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
            .chart-label span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
            .chart-label strong { flex: none; font-size: 12px; }
            .chart-track { height: 9px; overflow: hidden; background: var(--muted-bg); border-radius: 999px; }
            .chart-fill { display: block; height: 100%; border-radius: inherit; }
            .tone-blue { background: var(--chart-blue); }
            .tone-green { background: var(--chart-green); }
            .tone-orange { background: var(--chart-orange); }
            .tone-purple { background: var(--chart-purple); }
            .tone-red { background: var(--chart-red); }
            .tone-gray { background: var(--chart-gray); }
            .donut-layout { display: flex; align-items: center; gap: 18px; min-height: 138px; }
            .donut-chart { position: relative; flex: 0 0 126px; width: 126px; aspect-ratio: 1; display: grid; place-items: center; border-radius: 50%; }
            .donut-chart::before { content: ""; position: absolute; inset: 24%; background: var(--panel-bg); border-radius: 50%; }
            .donut-total { position: relative; z-index: 1; text-align: center; }
            .donut-total strong, .donut-total span { display: block; }
            .donut-total strong { font-size: 18px; }
            .donut-total span { color: var(--muted); font-size: 11px; }
            .donut-legend { min-width: 0; flex: 1; }
            .donut-legend-row { display: grid; grid-template-columns: 9px minmax(0, 1fr) auto; align-items: center; gap: 7px; }
            .donut-legend-row + .donut-legend-row { margin-top: 9px; }
            .donut-legend-row i { width: 9px; height: 9px; border-radius: 50%; }
            .donut-legend-row span { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
            .donut-legend-row strong { font-size: 12px; }
            .line-legend { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: -2px 0 8px; color: var(--muted); font-size: 12px; }
            .line-legend-item { display: inline-flex; align-items: center; gap: 6px; }
            .line-legend-key { flex: none; width: 28px; height: 8px; overflow: visible; }
            .line-legend-item strong { color: var(--text); font-size: 12px; }
            .chart-context { display: flex; align-items: center; justify-content: space-between; gap: 8px 14px; flex-wrap: wrap; margin: 5px 0 7px; }
            .chart-summary { flex: 1 1 420px; margin: 0; color: var(--muted); line-height: 1.45; }
            .line-chart-card { grid-column: 1 / -1; }
            .line-chart-scroll { position: relative; width: 100%; overflow: hidden; }
            .line-chart { display: block; width: 100%; height: auto; overflow: visible; }
            .line-axis, .line-tick { stroke: var(--muted); stroke-width: 1.25; vector-effect: non-scaling-stroke; }
            .line-path { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
            .line-point { stroke: var(--panel-bg); stroke-width: 2; vector-effect: non-scaling-stroke; }
            .line-axis-label { fill: var(--muted); font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            .line-daily-label { font-size: 11px; }
            .line-axis-title { fill: var(--text); font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            .trend-range-panel { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
            .trend-range-controls { display: flex; align-items: end; gap: 8px; flex-wrap: wrap; }
            .trend-range-controls label { display: grid; gap: 4px; color: var(--muted); font-size: 11px; }
            .trend-range-controls input[type="date"] { min-height: 36px; padding: 5px 8px; color: var(--text); color-scheme: light dark; background: var(--panel-bg); border: 1px solid var(--border); border-radius: 6px; }
            .trend-range-controls .button { min-height: 36px; }
            .trend-range-status { margin: 7px 0; color: var(--muted); font-size: 11px; }
            .trend-overview-shell { position: relative; height: 64px; overflow: hidden; background: var(--muted-bg); border: 1px solid var(--border); border-radius: 6px; touch-action: pan-y; }
            .trend-overview { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .78; }
            .trend-overview-selection { position: absolute; top: 0; bottom: 0; min-width: 2px; box-sizing: border-box; pointer-events: none; background: #0969da22; background: color-mix(in srgb, var(--accent) 16%, transparent); border-inline: 2px solid var(--accent); }
            .trend-range { position: absolute; inset: 0; width: 100%; height: 64px; margin: 0; padding: 0; appearance: none; -webkit-appearance: none; background: transparent; pointer-events: none; }
            .trend-range::-webkit-slider-runnable-track { height: 64px; background: transparent; }
            .trend-range::-webkit-slider-thumb { width: 16px; height: 64px; margin-top: 0; appearance: none; -webkit-appearance: none; pointer-events: auto; cursor: ew-resize; background: var(--panel-bg); border: 2px solid var(--border); border-radius: 3px; box-shadow: 0 0 0 1px #0002; }
            .trend-range::-moz-range-track { height: 64px; background: transparent; }
            .trend-range::-moz-range-thumb { width: 16px; height: 60px; pointer-events: auto; cursor: ew-resize; background: var(--panel-bg); border: 2px solid var(--border); border-radius: 3px; }
            .table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
            table { width: 100%; border-collapse: collapse; white-space: nowrap; }
            th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
            thead { background: var(--muted-bg); }
            tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
            td.reply { min-width: 250px; white-space: normal; }
            a { color: var(--accent); text-decoration: none; }
            a:hover { text-decoration: underline; }
            .reply span, .latest span { display: block; color: var(--muted); margin-top: 2px; }
            details { margin-top: 12px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
            details.table-details { margin-top: 10px; }
            summary { cursor: pointer; font-weight: 600; }
            #token-state[data-configured="true"] { color: var(--chart-green); }
            .token-row { display: flex; gap: 7px; margin-top: 10px; }
            #token { flex: 1; min-width: 160px; padding: 6px 8px; color: var(--text); background: var(--panel-bg); border: 1px solid var(--border); border-radius: 6px; }
            .help { margin: 8px 0 0; color: var(--muted); line-height: 1.5; }
            @media (max-width: 620px) {
              #panel { right: 8px; bottom: 58px; width: calc(100vw - 16px); max-height: calc(100vh - 70px); }
              #launcher { right: 10px; bottom: 10px; }
              .card.latest { grid-column: span 1; }
              .snapshot-strip { display: grid; grid-template-columns: 1fr; }
              .chart-context { align-items: stretch; }
              .trend-range-controls { display: grid; grid-template-columns: 1fr 1fr; align-items: end; }
              .trend-range-controls label, .trend-range-controls input[type="date"] { width: 100%; box-sizing: border-box; }
              .trend-range-controls input[type="date"], .trend-range-controls .button { min-height: 44px; }
              .trend-range-controls .button { grid-column: 1 / -1; }
            }
          </style>
          <button id="launcher" aria-controls="panel" aria-expanded="false" hidden>仓库统计</button>
          <section id="panel" hidden role="dialog" aria-labelledby="title" aria-modal="false" tabindex="-1">
            <header>
              <h2 id="title">GitHub 仓库统计</h2>
              <button id="close" title="关闭" aria-label="关闭">×</button>
            </header>
            <main>
              <div class="toolbar">
                <div class="scope" role="group" aria-label="统计范围">
                  <button id="scope-all" class="active" aria-pressed="true">全部历史</button>
                  <button id="scope-open" aria-pressed="false">仅 Open</button>
                </div>
                <button id="analyze" class="button primary">开始分析</button>
                <button id="pause" class="button" disabled>暂停</button>
                <button id="refresh-rate-limits" class="button">刷新实际额度</button>
                <button id="export" class="button" disabled>导出 JSON</button>
              </div>
              <div class="options" aria-label="分析模块">
                <label><input id="include-issues" type="checkbox" checked>Issue 统计</label>
                <label><input id="include-commits" type="checkbox" checked>Commit 概览（1 REST）</label>
                <label title="Open 模式至少每个 PR 一次 REST；全部历史按每 100 条行内评论一次 REST"><input id="complete-interactions" type="checkbox">完整互动（高成本）</label>
              </div>
              <p id="status" role="status" aria-live="polite">请选择范围和选项，然后点击“开始分析”</p>
              <div id="progress-wrap" hidden>
                <div id="progress-head"><span id="progress-label"></span><strong id="progress-percent"></strong></div>
                <progress id="progress" max="100" value="0" aria-labelledby="progress-label"></progress>
              </div>
              <div id="snapshot" class="snapshot-strip" aria-label="数据快照状态" hidden></div>
              <section class="section">
                <h3>Pull Request</h3>
                <div id="cards" class="cards"></div>
                <div id="pr-charts" class="charts"></div>
                <details class="table-details"><summary>查看 PR 详细对比表</summary><div class="table-wrap"><table id="table"></table></div></details>
              </section>
              <section id="issue-section" class="section" hidden>
                <h3>Issue</h3>
                <div id="issue-cards" class="cards"></div>
                <div id="issue-charts" class="charts"></div>
                <details class="table-details"><summary>查看 Issue 分类表</summary><div class="table-wrap"><table id="issue-table"></table></div></details>
              </section>
              <section class="section">
                <h3>贡献者（最近活跃优先，最多显示 25 人）</h3>
                <div id="contributor-cards" class="cards"></div>
                <div id="contributor-charts" class="charts"></div>
                <details class="table-details"><summary>查看贡献者明细</summary><div class="table-wrap"><table id="contributor-table"></table></div></details>
              </section>
              <section id="commit-section" class="section" hidden>
                <h3>Commit</h3>
                <div id="commit-cards" class="cards"></div>
                <div id="commit-charts" class="charts"></div>
                <details class="table-details"><summary>查看 Commit 作者明细</summary><div class="table-wrap"><table id="commit-table"></table></div></details>
              </section>
              <details open>
                <summary>信息来源与 API 成本</summary>
                <div class="table-wrap"><table id="cost-table"></table></div>
              </details>
              <details open>
                <summary>分析日志</summary>
                <pre id="log" role="log" aria-live="off"></pre>
              </details>
              <details id="settings">
                <summary>GitHub Token 设置（<span id="token-state">未配置</span>）</summary>
                <div class="token-row">
                  <input id="token" type="password" autocomplete="off" placeholder="github_pat_… 或 ghp_…">
                  <button id="save-token" class="button">保存</button>
                  <button id="clear-token" class="button">清除 Token</button>
                </div>
                <p class="help">
                  GitHub REST/GraphQL API 使用同一个 Token。私有仓库需要仓库元数据、Pull requests、Issues 与 Contents 只读权限。
                  Token 只保存在油猴扩展存储中，不会写入页面或仓库。
                </p>
              </details>
              <p class="help">
                主 GraphQL 查询保留 PR/Issue 标题和正文；评论/Review 只请求作者、身份关系、发布时间和修改时间，不请求正文。“完整互动”的 REST 响应可能自带正文，但脚本会立即丢弃，不分析也不导出。行内 Review 评论仅在“完整互动”启用时加入。维护者指 OWNER、MEMBER 或 COLLABORATOR，并排除提交者本人和机器人。
                PR 实线按创建日期累计，缺失日期沿用前一天累计值；提交者回复、维护者回复和 stale 显示为当前总数的不同线型水平参考线，图例与文字摘要始终显示数值，不只依赖颜色或悬停。图中不显示网格；横坐标每天显示一个完整日期，历史较长时可用键盘、滚动或前后 30 天按钮浏览并默认定位到最新日期，Y 轴会固定在左侧。回复与 stale 是当前分析状态，并非历史快照。stale 按最后一次人工创建、正文编辑、最新 PR Commit、评论或 Review 计算，分别显示 30/90 天阈值；不会把机器人或标签更新当成人工活跃。
                贡献者仅统计提交过 PR 或出现在 Commit 数据中的代码贡献者，Issue-only 用户不计入。核心贡献者默认指内部成员，或达到 5 个合并 PR、10 次 Review、20 个 Commit 任一阈值。Commit 统计采用 GitHub 缓存口径，排除 merge commit；Commit 活跃时间精确到周。
                执行流程严格分为“读取原始数据”和“本地分析”两个阶段；只有读取阶段访问 GitHub API，本地分析每处理 50 条更新一次日志和进度条。点击“暂停”会等待当前 API 请求完成，再保存检查点并停止。
              </p>
            </main>
          </section>
        `;
        document.body.appendChild(host);

        const get = (selector) => shadow.querySelector(selector);
        ui = {
            host,
            launcher: get("#launcher"),
            panel: get("#panel"),
            title: get("#title"),
            close: get("#close"),
            analyze: get("#analyze"),
            pause: get("#pause"),
            refreshRateLimits: get("#refresh-rate-limits"),
            export: get("#export"),
            scopeAll: get("#scope-all"),
            scopeOpen: get("#scope-open"),
            includeIssues: get("#include-issues"),
            includeCommits: get("#include-commits"),
            completeInteractions: get("#complete-interactions"),
            status: get("#status"),
            progressWrap: get("#progress-wrap"),
            progress: get("#progress"),
            progressLabel: get("#progress-label"),
            progressPercent: get("#progress-percent"),
            snapshot: get("#snapshot"),
            log: get("#log"),
            cards: get("#cards"),
            prCharts: get("#pr-charts"),
            table: get("#table"),
            issueSection: get("#issue-section"),
            issueCards: get("#issue-cards"),
            issueCharts: get("#issue-charts"),
            issueTable: get("#issue-table"),
            contributorCards: get("#contributor-cards"),
            contributorCharts: get("#contributor-charts"),
            contributorTable: get("#contributor-table"),
            commitSection: get("#commit-section"),
            commitCards: get("#commit-cards"),
            commitCharts: get("#commit-charts"),
            commitTable: get("#commit-table"),
            costTable: get("#cost-table"),
            settings: get("#settings"),
            tokenState: get("#token-state"),
            token: get("#token"),
            saveToken: get("#save-token"),
            clearToken: get("#clear-token"),
        };

        const storedOptions = GM_getValue(OPTIONS_KEY, DEFAULT_OPTIONS);
        for (const [key, fallback] of Object.entries(DEFAULT_OPTIONS)) {
            ui[key].checked =
                typeof storedOptions?.[key] === "boolean"
                    ? storedOptions[key]
                    : fallback;
        }

        ui.launcher.addEventListener("click", () => {
            const opening = ui.panel.hidden;
            ui.panel.hidden = !opening;
            ui.launcher.setAttribute(
                "aria-expanded",
                String(!ui.panel.hidden),
            );
            if (opening) ui.close.focus();
        });
        ui.close.addEventListener("click", () => {
            ui.panel.hidden = true;
            ui.launcher.setAttribute("aria-expanded", "false");
            ui.launcher.focus();
        });
        ui.panel.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            ui.panel.hidden = true;
            ui.launcher.setAttribute("aria-expanded", "false");
            ui.launcher.focus();
        });
        ui.analyze.addEventListener("click", runAnalysis);
        ui.pause.addEventListener("click", requestPause);
        ui.refreshRateLimits.addEventListener("click", refreshRateLimits);
        ui.export.addEventListener("click", exportAnalysis);
        ui.scopeAll.addEventListener("click", () => setScope("all"));
        ui.scopeOpen.addEventListener("click", () => setScope("open"));
        ui.saveToken.addEventListener("click", saveToken);
        ui.clearToken.addEventListener("click", clearToken);
        for (const input of [
            ui.includeIssues,
            ui.includeCommits,
            ui.completeInteractions,
        ]) {
            input.addEventListener("change", saveOptions);
        }
        ui.token.addEventListener("keydown", (event) => {
            if (event.key === "Enter") saveToken();
        });
        updateTokenState();
        renderCostGuide();
    }

    function updateScopeButtons() {
        const isAll = scope === "all";
        ui.scopeAll.classList.toggle("active", isAll);
        ui.scopeOpen.classList.toggle("active", !isAll);
        ui.scopeAll.setAttribute("aria-pressed", String(isAll));
        ui.scopeOpen.setAttribute("aria-pressed", String(!isAll));
    }

    function setScope(value) {
        if (loading || value === scope) return;
        clearFetchCheckpoint();
        scope = value;
        updateScopeButtons();
        if (
            analysis &&
            (analyzedScope === "all" || analyzedScope === value)
        ) {
            render();
        } else if (!ui.panel.hidden) {
            resetOutput();
            renderCostGuide();
            setStatus(
                `已选择“${value === "all" ? "全部历史" : "仅 Open"}”；确认选项后点击“${analysis ? "重新分析" : "开始分析"}”`,
            );
        }
    }

    function handleRouteChange() {
        if (!ui.host.isConnected) document.body.appendChild(ui.host);
        const repository = parseRepository();
        ui.launcher.hidden = !repository;
        if (!repository) {
            ui.panel.hidden = true;
            ui.launcher.setAttribute("aria-expanded", "false");
            return;
        }
        const changed =
            !currentRepository ||
            repository.owner !== currentRepository.owner ||
            repository.name !== currentRepository.name;
        currentRepository = repository;
        ui.title.textContent = `${repository.owner}/${repository.name} 仓库统计 v${SCRIPT_VERSION}`;
        if (changed) {
            if (!fetchCheckpoint) {
                const storedCheckpoint = GM_getValue(CHECKPOINT_KEY, null);
                fetchCheckpoint =
                    storedCheckpoint?.version === CHECKPOINT_VERSION
                        ? storedCheckpoint
                        : null;
            }
            if (
                fetchCheckpoint?.repository?.owner === repository.owner &&
                fetchCheckpoint?.repository?.name === repository.name
            ) {
                scope = fetchCheckpoint.selectedScope;
                updateScopeButtons();
                for (const [key, fallback] of Object.entries(DEFAULT_OPTIONS)) {
                    ui[key].checked =
                        typeof fetchCheckpoint.selectedOptions?.[key] ===
                        "boolean"
                            ? fetchCheckpoint.selectedOptions[key]
                            : fallback;
                }
            }
            const resumeCheckpoint = compatibleFetchCheckpoint(
                repository,
                scope,
                selectedOptions(),
            );
            analysis = null;
            analyzedScope = null;
            analyzedOptions = null;
            overflowItems = [];
            lastRateLimits = { graphql: null, rest: null };
            lastUsage = {
                graphqlPoints: 0,
                graphqlRequests: 0,
                restRequests: 0,
                overflowRest: 0,
                inlineCommentRest: 0,
                commitStatsRest: 0,
                ...(resumeCheckpoint?.usage || {}),
            };
            ui.log.textContent = "";
            resetOutput();
            renderCostGuide();
            ui.analyze.textContent = resumeCheckpoint
                ? "继续分析"
                : "开始分析";
            setStatus(
                resumeCheckpoint
                    ? `检测到未完成读取：PR ${resumeCheckpoint.pullRequests?.length || 0}/${resumeCheckpoint.prTotal ?? "?"}、Issue ${resumeCheckpoint.issues?.length || 0}/${resumeCheckpoint.issueTotal ?? "?"}；点击“继续分析”从未完成页继续`
                    : "请选择范围和选项，然后点击“开始分析”",
            );
        }
    }

    if (typeof module === "object" && module.exports) {
        module.exports = {
            analyzePullRequest,
            analyzeIssue,
            analyzeCommitContributors,
            analyzeRepositoryData,
            barChartMarkup,
            buildContributorStatistics,
            buildPullRequestTrend,
            donutChartMarkup,
            fetchRepositoryData,
            fetchRateLimits,
            formatRateLimit,
            formatRateLimitChange,
            lineChartMarkup,
            normalizeRestComment,
            normalizeRestReview,
            percentage,
            pullNumberFromUrl,
            rate,
            rateLimitFromHeaders,
            requestGraphQL,
            summarize,
            summarizeIssues,
            summarizePullRequests,
        };
        return;
    }

    createUi();
    handleRouteChange();
    document.addEventListener("turbo:load", handleRouteChange);
    document.addEventListener("pjax:end", handleRouteChange);
    window.addEventListener("popstate", handleRouteChange);
})();
