// ==UserScript==
// @name         GitHub 仓库贡献统计
// @name:en      GitHub Repository Contribution Statistics
// @namespace    https://github.com/aik4o
// @version      0.6.2
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
    const DAY_MS = 24 * 60 * 60 * 1000;
    const HAN_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
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
    let scope = "open";
    let analyzedScope = null;
    let analyzedOptions = null;
    let loading = false;
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

    function classifyLanguage(title, body) {
        return HAN_PATTERN.test(`${title || ""}\n${body || ""}`)
            ? "chinese"
            : "english";
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
            language: classifyLanguage(pr.title, pr.body),
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
            chinese: groupStatistics(
                scopedRows.filter((row) => row.language === "chinese"),
            ),
            english: groupStatistics(
                scopedRows.filter((row) => row.language === "english"),
            ),
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

        const rows = [...people.values()].map((row) => {
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

    function requestGraphQL(query, token, variables) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: "https://api.github.com/graphql",
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "X-GitHub-Api-Version": "2026-03-10",
                },
                data: JSON.stringify({ query, variables }),
                timeout: 30000,
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
                        reject(error);
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
                        reject(error);
                        return;
                    }
                    if (payload.errors?.length) {
                        reject(
                            new Error(
                                formatApiError(
                                    payload.errors
                                        .map((error) => error.message)
                                        .join("；"),
                                    response,
                                ),
                            ),
                        );
                        return;
                    }
                    resolve(payload.data);
                },
                onerror() {
                    reject(new Error("无法连接 GitHub API"));
                },
                ontimeout() {
                    reject(new Error("GitHub API 请求超时"));
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
                },
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
                onerror() {
                    reject(new Error("无法连接 GitHub REST API"));
                },
                ontimeout() {
                    reject(new Error("GitHub REST API 请求超时"));
                },
            });
        });
    }

    async function fetchRateLimits(token) {
        const result = await requestRest(
            token,
            "https://api.github.com/rate_limit",
            { expectArray: false },
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

    async function fetchRestPages(url, token, onPage) {
        let page = 1;
        let total = 0;
        let hasNextPage = true;
        let rateLimit = null;
        while (hasNextPage) {
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
    ) {
        const nodes = [];
        await fetchRestPages(url, token, (items, page, total, rateLimit) => {
            usage.restRequests += 1;
            usage.overflowRest += 1;
            nodes.push(...items.map(normalize));
            rateLimits.rest = rateLimit;
            onProgress(
                `${label}第 ${page} 页完成；累计 ${total} 条`,
                rateLimit,
            );
        });
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
    ) {
        const selectedOptions = { ...DEFAULT_OPTIONS, ...requestedOptions };
        let pageSize = MAX_PAGE_SIZE;
        const pullRequests = [];
        const issues = [];
        const rateLimits = {
            graphql: startingRateLimits?.graphql || null,
            rest: startingRateLimits?.rest || null,
        };
        const usage = {
            graphqlPoints: 0,
            graphqlRequests: 0,
            restRequests: 0,
            overflowRest: 0,
            inlineCommentRest: 0,
            commitStatsRest: 0,
        };
        let prCursor = null;
        let issueCursor = null;
        let fetchPulls = true;
        let fetchIssues = selectedOptions.includeIssues;
        let prTotal = null;
        let issueTotal = selectedOptions.includeIssues ? null : 0;
        let page = 0;
        let prPage = 0;
        let issuePage = 0;
        const combineResources = selectedScope === "open";

        while (fetchPulls || fetchIssues) {
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
            while (true) {
                onProgress(
                    `准备请求 GraphQL ${requestLabel}；对象上限 ${pageSize}/页；每个互动连接上限 ${INTERACTION_PREVIEW_SIZE} 条元数据（不含正文）`,
                    null,
                );
                const requestStartedAt = Date.now();
                try {
                    data = await requestGraphQL(REPOSITORY_QUERY, token, {
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
                    });
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
                    if (error.status !== 502 || nextPageSize === pageSize) {
                        const reason =
                            error.status === 502
                                ? `已到最小对象上限 ${pageSize}/页`
                                : "仅对 HTTP 502 执行安全降级";
                        throw new Error(
                            `${failure}；未自动重试：${reason}；${error.message || String(error)}`,
                        );
                    }

                    const beforeFailure = rateLimits.graphql;
                    if (!beforeFailure) {
                        throw new Error(
                            `${failure}；未自动重试：缺少失败前 GraphQL 额度基线，无法证明失败请求未扣点；${error.message || String(error)}`,
                        );
                    }

                    let checkedRateLimits;
                    try {
                        checkedRateLimits = await fetchRateLimits(token);
                    } catch (quotaError) {
                        throw new Error(
                            `${failure}；额度复核失败，未自动重试：${quotaError.message || String(quotaError)}；原始错误：${error.message || String(error)}`,
                        );
                    }
                    rateLimits.rest =
                        checkedRateLimits.rest || rateLimits.rest;
                    rateLimits.graphql =
                        checkedRateLimits.graphql || rateLimits.graphql;
                    const afterFailure = checkedRateLimits.graphql;
                    let unsafeReason = "";
                    let safeReason = "";
                    if (!afterFailure) {
                        unsafeReason = "额度查询未返回 GraphQL 数据";
                    } else if (
                        beforeFailure.resetAt !== afterFailure.resetAt
                    ) {
                        if (
                            afterFailure.used === 0 &&
                            afterFailure.remaining === afterFailure.limit
                        ) {
                            safeReason = `GraphQL 额度窗口已重置且新窗口为 0/${afterFailure.limit}，旧窗口消耗已失效，可安全重试`;
                        } else {
                            unsafeReason = `GraphQL 额度窗口已重置，但新窗口已用 ${afterFailure.used}/${afterFailure.limit}，无法排除失败请求已在新窗口扣点`;
                        }
                    } else if (beforeFailure.used !== afterFailure.used) {
                        unsafeReason = `GraphQL 已用额度从 ${beforeFailure.used} 变为 ${afterFailure.used}，失败请求可能已扣点`;
                    } else {
                        safeReason = `/rate_limit 确认 GraphQL 已用额度仍为 ${afterFailure.used}/${afterFailure.limit}，失败请求未扣点`;
                    }
                    if (unsafeReason) {
                        throw new Error(
                            `${failure}；未自动重试：${unsafeReason}；${error.message || String(error)}`,
                        );
                    }

                    onProgress(
                        `${failure}；${safeReason}；对象上限 ${pageSize} → ${nextPageSize}/页后自动重试`,
                        afterFailure,
                    );
                    pageSize = nextPageSize;
                }
            }
            if (!data?.repository) {
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
        }

        if (selectedOptions.completeInteractions) {
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
            );
        }

        let commitResult = { entries: null, status: null };
        if (selectedOptions.includeCommits) {
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
        const tones = new Set([
            "blue",
            "green",
            "orange",
            "purple",
            "red",
            "gray",
        ]);
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
                        const safeTone = tones.has(tone) ? tone : "blue";
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
            <thead><tr><th>信息</th><th>来源</th><th>额外查询</th><th>成本</th><th>评价</th></tr></thead>
            <tbody>${rows
                .map(
                    (row) =>
                        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
                )
                .join("")}</tbody>
        `;
    }

    function statRows(summary) {
        return [
            ["中文", summary.chinese],
            ["英文", summary.english],
            ["全部", summary.total],
        ];
    }

    function render() {
        if (!analysis) return;
        const summary = summarizePullRequests(analysis.rows, scope);
        const isOpen = scope === "open";
        const total = summary.total.count;
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
                      "中文 Open PR",
                      countAndRate(summary.chinese.count, total),
                  ],
                  [
                      "英文 Open PR",
                      countAndRate(summary.english.count, total),
                  ],
                  [
                      "维护者回复率",
                      rate(summary.total.maintainerReplied, total),
                      "key",
                  ],
                  [
                      "中文维护者回复率",
                      rate(
                          summary.chinese.maintainerReplied,
                          summary.chinese.count,
                      ),
                  ],
                  [
                      "英文维护者回复率",
                      rate(
                          summary.english.maintainerReplied,
                          summary.english.count,
                      ),
                  ],
                  ["30 天 stale", countAndRate(summary.total.stale30, total)],
                  ["90 天 stale", countAndRate(summary.total.stale90, total)],
                  [
                      "维护者最近回复",
                      latestReplyHtml(summary.total.latestMaintainerReply, true),
                      "latest",
                  ],
              ]
            : [
                  ["PR", total, "key"],
                  [
                      "中文 PR",
                      countAndRate(summary.chinese.count, total),
                  ],
                  [
                      "英文 PR",
                      countAndRate(summary.english.count, total),
                  ],
                  ["总体合并率", rate(summary.total.merged, total), "key"],
                  [
                      "中文合并率",
                      rate(summary.chinese.merged, summary.chinese.count),
                  ],
                  [
                      "英文合并率",
                      rate(summary.english.merged, summary.english.count),
                  ],
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
        const languageRows = [
            rateRow("中文", summary.chinese.count, total, "purple"),
            rateRow("英文", summary.english.count, total, "blue"),
        ];
        const comparisonRows = isOpen
            ? [
                  rateRow(
                      "全部",
                      summary.total.maintainerReplied,
                      total,
                      "green",
                  ),
                  rateRow(
                      "中文",
                      summary.chinese.maintainerReplied,
                      summary.chinese.count,
                      "purple",
                  ),
                  rateRow(
                      "英文",
                      summary.english.maintainerReplied,
                      summary.english.count,
                      "blue",
                  ),
              ]
            : [
                  rateRow("全部", summary.total.merged, total, "green"),
                  rateRow(
                      "中文",
                      summary.chinese.merged,
                      summary.chinese.count,
                      "purple",
                  ),
                  rateRow(
                      "英文",
                      summary.english.merged,
                      summary.english.count,
                      "blue",
                  ),
              ];
        const healthRows = [
            rateRow(
                "提交者回复",
                summary.total.submitterReplied,
                total,
                "blue",
            ),
            rateRow(
                "维护者回复",
                summary.total.maintainerReplied,
                total,
                "green",
            ),
            rateRow("30 天 stale", summary.total.stale30, total, "orange"),
            rateRow("90 天 stale", summary.total.stale90, total, "red"),
        ];
        ui.prCharts.innerHTML = [
            barChartMarkup("语言分布", languageRows),
            barChartMarkup(
                isOpen ? "维护者回复率（按语言）" : "合并率（按语言）",
                comparisonRows,
            ),
            barChartMarkup("协作与健康", healthRows),
        ].join("");

        const mergeHeader = isOpen
            ? ""
            : "<th>已合并 / 合并率</th>";
        ui.table.innerHTML = `
            <thead>
              <tr>
                <th>分类</th>
                <th>PR 数 / 占比</th>
                ${mergeHeader}
                <th>提交者回复率</th>
                <th>维护者回复率</th>
                <th>30 天 stale</th>
                <th>首次维护者回复中位数</th>
                <th>维护者最近回复时间</th>
              </tr>
            </thead>
            <tbody>
              ${statRows(summary)
                  .map(([label, stats]) => {
                      const denominator = stats.count;
                      return `
                        <tr>
                          <th>${label}</th>
                          <td>${countAndRate(stats.count, total)}</td>
                          ${
                              isOpen
                                  ? ""
                                  : `<td>${stats.merged} / ${denominator}（${rate(
                                        stats.merged,
                                        denominator,
                                    )}）</td>`
                          }
                          <td>${stats.submitterReplied} / ${denominator}（${rate(
                              stats.submitterReplied,
                              denominator,
                          )}）</td>
                          <td>${stats.maintainerReplied} / ${denominator}（${rate(
                              stats.maintainerReplied,
                              denominator,
                          )}）</td>
                          <td>${stats.stale30} / ${denominator}（${rate(
                              stats.stale30,
                              denominator,
                          )}）</td>
                          <td>${formatDuration(
                              stats.medianFirstMaintainerResponseHours,
                          )}</td>
                          <td class="reply">${latestReplyHtml(
                              stats.latestMaintainerReply,
                          )}</td>
                        </tr>
                      `;
                  })
                  .join("")}
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
                <thead><tr><th>Bug</th><th>Feature</th><th>Docs</th><th>Good first issue</th><th>Help wanted</th></tr></thead>
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
            ["贡献者", contributorSummary.count, "key"],
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
        const contributorStructureRows = [
            rateRow(
                "外部贡献者",
                contributorSummary.external,
                contributorSummary.count,
                "blue",
            ),
            rateRow(
                "持续外部",
                contributorSummary.recurringExternal,
                contributorSummary.count,
                "purple",
            ),
            rateRow(
                "内部成员",
                contributorSummary.internal,
                contributorSummary.count,
                "green",
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
            barChartMarkup("贡献者结构", contributorStructureRows),
            barChartMarkup("最近活跃", contributorActivityRows),
        ].join("");
        ui.contributorTable.innerHTML = `
            <thead><tr><th>贡献者</th><th>最近活跃</th><th>角色</th><th>PR / 合并</th><th>Issue</th><th>评论</th><th>Review</th><th>Commit</th></tr></thead>
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
                const monthlyRows = commits.monthly.map(
                    ([month, count], index) => [
                        month,
                        count,
                        count,
                        ["blue", "green", "purple"][index % 3],
                    ],
                );
                const authorRows = commits.authors
                    .slice(0, 8)
                    .map((row, index) => [
                        row.login,
                        row.total,
                        `${row.total}（${rate(row.total, commits.totalCommits)}）`,
                        ["green", "blue", "purple", "orange"][index % 4],
                    ]);
                ui.commitCharts.innerHTML = [
                    monthlyRows.length
                        ? barChartMarkup(
                              "最近 12 个月 Commit",
                              monthlyRows,
                              Math.max(1, ...monthlyRows.map((row) => row[1])),
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
                    <thead><tr><th>作者</th><th>Commit</th><th>占比</th></tr></thead>
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
        const rateLimit = quotas ? `；${quotas}` : "";
        const usage = `；本次消耗 GraphQL ${lastUsage.graphqlPoints} points / ${lastUsage.graphqlRequests} 次请求，REST ${lastUsage.restRequests} 次请求`;
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
        ui.analyze.disabled = value;
        ui.refreshRateLimits.disabled = value;
        ui.scopeAll.disabled = value;
        ui.scopeOpen.disabled = value;
        ui.includeIssues.disabled = value;
        ui.includeCommits.disabled = value;
        ui.completeInteractions.disabled = value;
        ui.export.disabled = value || !analysis;
        ui.analyze.textContent = value ? "分析中…" : "重新分析";
    }

    function selectedOptions() {
        return {
            includeIssues: ui.includeIssues.checked,
            includeCommits: ui.includeCommits.checked,
            completeInteractions: ui.completeInteractions.checked,
        };
    }

    function saveOptions() {
        GM_setValue(OPTIONS_KEY, selectedOptions());
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
                `额度查询完成（不消耗 REST 主额度）；${formatRateLimits()}`,
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
        const graphQlStrategy =
            requestedScope === "open"
                ? `合并 PR/Issue GraphQL 自适应分页（初始 ${MAX_PAGE_SIZE}/页，失败 -${PAGE_SIZE_STEP}，成功 +${PAGE_SIZE_STEP}）`
                : `PR/Issue 分离 GraphQL 自适应分页（初始 ${MAX_PAGE_SIZE}/页，失败 -${PAGE_SIZE_STEP}，成功 +${PAGE_SIZE_STEP}）`;
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
        };
        analysis = null;
        analyzedScope = null;
        analyzedOptions = null;
        overflowItems = [];
        setLoading(true);
        resetOutput();
        setProgress(null, "读取数据：准备请求 GitHub API");
        setStatus(
            `开始读取 ${currentRepository.owner}/${currentRepository.name} 的原始数据；范围：${
                requestedScope === "open" ? "仅 Open" : "全部历史"
            }；低额度策略：${strategy}；${modules}`,
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
            );
            lastRateLimits = {
                rest:
                    fetchedData.rateLimits.rest ||
                    baselineRateLimits?.rest ||
                    null,
                graphql:
                    fetchedData.rateLimits.graphql ||
                    baselineRateLimits?.graphql ||
                    null,
            };
            lastUsage = fetchedData.usage;
            const rateLimitChange = formatRateLimitChange(
                baselineRateLimits,
                lastRateLimits,
            );
            if (rateLimitChange) {
                setStatus(
                    `数据读取完成后的额度；${formatRateLimits()}；${rateLimitChange}`,
                );
            }
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
        } catch (error) {
            const currentProgress = ui.progress.hasAttribute("value")
                ? ui.progress.value
                : 0;
            if (phase === "analysis") {
                setProgress(currentProgress, "本地分析失败");
                setStatus(
                    `本地分析失败；原始数据已经读取完成，本阶段没有调用 GitHub API；${error.message || String(error)}`,
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
            setStatus(
                `${error.message || String(error)}${quotaDetails}`,
                "error",
            );
        } finally {
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
        GM_setValue(TOKEN_KEY, token);
        ui.token.value = "";
        ui.settings.open = false;
        updateTokenState();
        setStatus("Token 已保存；请选择分析选项，然后点击“开始分析”", "success");
    }

    function clearToken() {
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
              --chart-blue: #2f81f7;
              --chart-green: #3fb950;
              --chart-orange: #d29922;
              --chart-purple: #a371f7;
              --chart-red: #f85149;
              --chart-gray: #8c959f;
              font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            [hidden] { display: none !important; }
            button, input { font: inherit; }
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
            #status[data-type="error"] { color: #cf222e; }
            #status[data-type="success"] { color: #1a7f37; }
            #progress-wrap { margin: 8px 0 10px; }
            #progress-head { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 4px; color: var(--muted); font-size: 12px; }
            #progress { width: 100%; height: 12px; accent-color: var(--accent); }
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
            #token-state[data-configured="true"] { color: #1a7f37; }
            .token-row { display: flex; gap: 7px; margin-top: 10px; }
            #token { flex: 1; min-width: 160px; padding: 6px 8px; color: var(--text); background: var(--panel-bg); border: 1px solid var(--border); border-radius: 6px; }
            .help { margin: 8px 0 0; color: var(--muted); line-height: 1.5; }
            @media (max-width: 620px) {
              #panel { right: 8px; bottom: 58px; width: calc(100vw - 16px); max-height: calc(100vh - 70px); }
              #launcher { right: 10px; bottom: 10px; }
              .card.latest { grid-column: span 1; }
            }
          </style>
          <button id="launcher" aria-controls="panel" aria-expanded="false" hidden>仓库统计</button>
          <section id="panel" hidden aria-label="GitHub 仓库统计">
            <header>
              <h2 id="title">GitHub 仓库统计</h2>
              <button id="close" title="关闭" aria-label="关闭">×</button>
            </header>
            <main>
              <div class="toolbar">
                <div class="scope" aria-label="统计范围">
                  <button id="scope-all">全部历史</button>
                  <button id="scope-open" class="active">仅 Open</button>
                </div>
                <button id="analyze" class="button primary">开始分析</button>
                <button id="refresh-rate-limits" class="button">刷新额度</button>
                <button id="export" class="button" disabled>导出 JSON</button>
              </div>
              <div class="options" aria-label="分析模块">
                <label><input id="include-issues" type="checkbox" checked>Issue 统计</label>
                <label><input id="include-commits" type="checkbox" checked>Commit 概览（1 REST）</label>
                <label title="Open 模式至少每个 PR 一次 REST；全部历史按每 100 条行内评论一次 REST"><input id="complete-interactions" type="checkbox">完整互动（高成本）</label>
              </div>
              <p id="status">请选择范围和选项，然后点击“开始分析”</p>
              <div id="progress-wrap" hidden>
                <div id="progress-head"><span id="progress-label"></span><strong id="progress-percent"></strong></div>
                <progress id="progress" max="100" value="0" aria-labelledby="progress-label"></progress>
              </div>
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
                <pre id="log" role="log" aria-live="polite"></pre>
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
                中文判定：标题或原始正文任一处含中文。主 GraphQL 查询只请求评论/Review 的作者、身份关系、发布时间和修改时间，不请求正文；“完整互动”的 REST 响应可能自带正文，但脚本会立即丢弃，不分析也不导出。行内 Review 评论仅在“完整互动”启用时加入。维护者指 OWNER、MEMBER 或 COLLABORATOR，并排除提交者本人和机器人。
                stale 按最后一次人工创建、正文编辑、最新 PR Commit、评论或 Review 计算，分别显示 30/90 天阈值；不会把机器人或标签更新当成人工活跃。
                核心贡献者默认指内部成员，或达到 5 个合并 PR、10 次 Review、20 个 Commit 任一阈值。Commit 统计采用 GitHub 缓存口径，排除 merge commit；Commit 活跃时间精确到周。
                执行流程严格分为“读取原始数据”和“本地分析”两个阶段；只有读取阶段访问 GitHub API，本地分析每处理 50 条更新一次日志和进度条。
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
            ui.panel.hidden = !ui.panel.hidden;
            ui.launcher.setAttribute(
                "aria-expanded",
                String(!ui.panel.hidden),
            );
        });
        ui.close.addEventListener("click", () => {
            ui.panel.hidden = true;
            ui.launcher.setAttribute("aria-expanded", "false");
        });
        ui.analyze.addEventListener("click", runAnalysis);
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

    function setScope(value) {
        if (loading || value === scope) return;
        scope = value;
        ui.scopeAll.classList.toggle("active", value === "all");
        ui.scopeOpen.classList.toggle("active", value === "open");
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
        ui.title.textContent = `${repository.owner}/${repository.name} 仓库统计`;
        if (changed) {
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
            };
            ui.log.textContent = "";
            resetOutput();
            renderCostGuide();
            setStatus("请选择范围和选项，然后点击“开始分析”");
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
            classifyLanguage,
            fetchRepositoryData,
            fetchRateLimits,
            formatRateLimit,
            formatRateLimitChange,
            normalizeRestComment,
            normalizeRestReview,
            percentage,
            pullNumberFromUrl,
            rate,
            rateLimitFromHeaders,
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
