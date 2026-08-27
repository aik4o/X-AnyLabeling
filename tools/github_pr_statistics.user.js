// ==UserScript==
// @name         GitHub PR 中英文统计
// @name:en      GitHub PR Language Statistics
// @namespace    https://github.com/aik4o
// @version      0.1.3
// @description  统计仓库中英文 PR 的合并率、提交者/维护者回复率和维护者最近回复时间
// @description:en Analyze PR language, merge rate, reply rate, and latest maintainer reply
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
    const HAN_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
    const MAINTAINER_ASSOCIATIONS = new Set([
        "OWNER",
        "MEMBER",
        "COLLABORATOR",
    ]);
    const QUERY = `
        query($owner: String!, $name: String!, $states: [PullRequestState!], $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(
              first: 100
              after: $cursor
              states: $states
              orderBy: {field: CREATED_AT, direction: ASC}
            ) {
              pageInfo { hasNextPage endCursor }
              nodes {
                number
                title
                body
                url
                state
                mergedAt
                author { login }
                comments(first: 100) {
                  pageInfo { hasNextPage }
                  nodes {
                    author { login }
                    authorAssociation
                    createdAt
                  }
                }
                reviews(first: 100) {
                  pageInfo { hasNextPage }
                  nodes {
                    author { login }
                    authorAssociation
                    submittedAt
                  }
                }
                reviewThreads(first: 40) {
                  pageInfo { hasNextPage }
                  nodes {
                    comments(first: 100) {
                      pageInfo { hasNextPage }
                      nodes {
                        author { login }
                        authorAssociation
                        createdAt
                      }
                    }
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
    let analyzedRows = null;
    let scope = "open";
    let analyzedScope = null;
    let loading = false;
    let lastRateLimit = null;
    let overflowPrs = [];

    function classifyLanguage(title, body) {
        return HAN_PATTERN.test(`${title || ""}\n${body || ""}`)
            ? "chinese"
            : "english";
    }

    function isBot(login) {
        return /\[bot\]$/i.test(login || "");
    }

    function latestEvent(events) {
        return events.reduce((latest, event) => {
            if (!event || !event.at) return latest;
            return !latest || Date.parse(event.at) > Date.parse(latest.at)
                ? event
                : latest;
        }, null);
    }

    function analyzePullRequest(pr) {
        const author = pr.author?.login || "";
        const threadComments = (pr.reviewThreads?.nodes || []).flatMap(
            (thread) => thread.comments?.nodes || [],
        );
        const events = [
            ...(pr.comments?.nodes || []).map((event) => ({
                login: event.author?.login || "",
                association: event.authorAssociation,
                at: event.createdAt,
            })),
            ...(pr.reviews?.nodes || []).map((event) => ({
                login: event.author?.login || "",
                association: event.authorAssociation,
                at: event.submittedAt,
            })),
            ...threadComments.map((event) => ({
                login: event.author?.login || "",
                association: event.authorAssociation,
                at: event.createdAt,
            })),
        ].filter((event) => event.login && event.at);
        const maintainerEvents = events
            .filter(
                (event) =>
                    event.login !== author &&
                    !isBot(event.login) &&
                    MAINTAINER_ASSOCIATIONS.has(event.association),
            )
            .map((event) => ({
                ...event,
                number: pr.number,
                title: pr.title,
                url: pr.url,
            }));

        return {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            language: classifyLanguage(pr.title, pr.body),
            merged: Boolean(pr.mergedAt),
            open: pr.state === "OPEN",
            submitterReplied: events.some((event) => event.login === author),
            maintainerReplied: maintainerEvents.length > 0,
            latestMaintainerReply: latestEvent(maintainerEvents),
        };
    }

    function groupStatistics(rows) {
        return {
            count: rows.length,
            merged: rows.filter((row) => row.merged).length,
            submitterReplied: rows.filter((row) => row.submitterReplied).length,
            maintainerReplied: rows.filter((row) => row.maintainerReplied).length,
            latestMaintainerReply: latestEvent(
                rows.map((row) => row.latestMaintainerReply).filter(Boolean),
            ),
        };
    }

    function summarize(rows, selectedScope) {
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

    function rate(numerator, denominator) {
        return denominator
            ? `${((100 * numerator) / denominator).toFixed(2)}%`
            : "—";
    }

    function formatRateLimit(value) {
        return `API 额度：已用 ${value.used}/${value.limit}（剩余 ${value.remaining}）`;
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
        return {
            limit,
            remaining,
            used,
            resetAt: new Date(reset * 1000).toISOString(),
        };
    }

    function formatApiError(message, response) {
        const rateLimit = rateLimitFromHeaders(response.responseHeaders);
        return rateLimit
            ? `${message}；${formatRateLimit(rateLimit)}，重置时间 ${formatDate(
                  rateLimit.resetAt,
              )}`
            : message;
    }

    function parseRepository() {
        const parts = location.pathname.split("/").filter(Boolean);
        if (
            parts.length < 3 ||
            !["pull", "pulls"].includes(parts[2])
        ) {
            return null;
        }
        return { owner: parts[0], name: parts[1] };
    }

    function requestGraphQL(token, variables) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: "https://api.github.com/graphql",
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                data: JSON.stringify({ query: QUERY, variables }),
                timeout: 30000,
                onload(response) {
                    let payload;
                    try {
                        payload = JSON.parse(response.responseText);
                    } catch (_error) {
                        reject(new Error("GitHub 返回了无法解析的数据"));
                        return;
                    }
                    if (response.status !== 200) {
                        reject(
                            new Error(
                                formatApiError(
                                    payload.message ||
                                        `GitHub API 请求失败 (${response.status})`,
                                    response,
                                ),
                            ),
                        );
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

    function hasNestedOverflow(pr) {
        return (
            pr.comments?.pageInfo?.hasNextPage ||
            pr.reviews?.pageInfo?.hasNextPage ||
            pr.reviewThreads?.pageInfo?.hasNextPage ||
            (pr.reviewThreads?.nodes || []).some(
                (thread) => thread.comments?.pageInfo?.hasNextPage,
            )
        );
    }

    async function fetchPullRequests(
        repository,
        token,
        selectedScope,
        onProgress,
    ) {
        const pullRequests = [];
        const overflow = [];
        let cursor = null;
        let page = 0;
        let hasNextPage = true;
        let rateLimit;

        while (hasNextPage) {
            const data = await requestGraphQL(token, {
                owner: repository.owner,
                name: repository.name,
                states: selectedScope === "open" ? ["OPEN"] : null,
                cursor,
            });
            if (!data.repository) {
                throw new Error("仓库不存在，或 Token 没有读取权限");
            }
            const connection = data.repository.pullRequests;
            pullRequests.push(...connection.nodes);
            overflow.push(
                ...connection.nodes
                    .filter(hasNestedOverflow)
                    .map((pr) => pr.number),
            );
            hasNextPage = connection.pageInfo.hasNextPage;
            cursor = connection.pageInfo.endCursor;
            rateLimit = data.rateLimit;
            page += 1;
            onProgress(pullRequests.length, page, rateLimit);
        }

        // ponytail: review threads are capped at 40 and other discussions at
        // 100 so a 100-PR page stays within GitHub's GraphQL query limits.
        return {
            rows: pullRequests.map(analyzePullRequest),
            overflow,
            rateLimit,
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

    function statRows(summary) {
        return [
            ["中文", summary.chinese],
            ["英文", summary.english],
            ["全部", summary.total],
        ];
    }

    function render() {
        if (!analyzedRows) return;
        const summary = summarize(analyzedRows, scope);
        const isOpen = scope === "open";
        const total = summary.total.count;
        const cards = isOpen
            ? [
                  ["Open PR", total],
                  [
                      "中文 Open PR",
                      countAndRate(summary.chinese.count, total),
                  ],
                  [
                      "英文 Open PR",
                      countAndRate(summary.english.count, total),
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
                  [
                      "维护者最近回复",
                      latestReplyHtml(summary.total.latestMaintainerReply, true),
                      "latest",
                  ],
              ]
            : [
                  [
                      "中文 PR",
                      countAndRate(summary.chinese.count, total),
                  ],
                  [
                      "英文 PR",
                      countAndRate(summary.english.count, total),
                  ],
                  ["总体合并率", rate(summary.total.merged, total)],
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
                  ],
                  [
                      "维护者最近回复",
                      latestReplyHtml(summary.total.latestMaintainerReply, true),
                      "latest",
                  ],
              ];

        ui.cards.innerHTML = cards
            .map(
                ([label, value, className = ""]) => `
                    <article class="card ${className}">
                      <span>${escapeHtml(label)}</span>
                      <strong>${value}</strong>
                    </article>
                `,
            )
            .join("");

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
                          <td class="reply">${latestReplyHtml(
                              stats.latestMaintainerReply,
                          )}</td>
                        </tr>
                      `;
                  })
                  .join("")}
            </tbody>
        `;

        const warning = overflowPrs.length
            ? `；PR #${overflowPrs.join(", #")} 的讨论数据超过单次检索上限，回复统计为下限`
            : "";
        const rateLimit = lastRateLimit
            ? `；${formatRateLimit(lastRateLimit)}，重置时间 ${formatDate(
                  lastRateLimit.resetAt,
              )}`
            : "";
        setStatus(
            `已分析 ${analyzedRows.length} 个 PR；当前显示 ${total} 个${warning}${rateLimit}`,
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

    function setLoading(value) {
        loading = value;
        ui.analyze.disabled = value;
        ui.scopeAll.disabled = value;
        ui.scopeOpen.disabled = value;
        ui.analyze.textContent = value ? "分析中…" : "重新分析";
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
        setLoading(true);
        ui.cards.innerHTML = "";
        ui.table.innerHTML = "";
        setStatus(
            `开始分析 ${currentRepository.owner}/${currentRepository.name}；范围：${
                requestedScope === "open" ? "仅 Open" : "全部 PR"
            }；PR 每页 100 个`,
        );
        try {
            const result = await fetchPullRequests(
                currentRepository,
                token,
                requestedScope,
                (count, page, rateLimit) => {
                    lastRateLimit = rateLimit;
                    setStatus(
                        `第 ${page} 页完成；累计 ${count} 个 PR；本页 cost ${rateLimit.cost}；${formatRateLimit(rateLimit)}`,
                    );
                },
            );
            analyzedRows = result.rows;
            analyzedScope = requestedScope;
            overflowPrs = result.overflow;
            lastRateLimit = result.rateLimit;
            render();
        } catch (error) {
            setStatus(error.message || String(error), "error");
        } finally {
            setLoading(false);
        }
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
        setStatus("Token 已保存，正在分析…", "success");
        runAnalysis();
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
              width: min(900px, calc(100vw - 44px));
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
            .scope { display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
            .scope button { padding: 6px 11px; border: 0; border-right: 1px solid var(--border); background: var(--panel-bg); color: var(--text); cursor: pointer; }
            .scope button:last-child { border-right: 0; }
            .scope button.active { color: #fff; background: var(--accent); }
            #status { margin: 10px 0; color: var(--muted); overflow-wrap: anywhere; }
            #status[data-type="error"] { color: #cf222e; }
            #status[data-type="success"] { color: #1a7f37; }
            #log { max-height: 160px; overflow: auto; margin: 8px 0 0; padding: 8px; color: var(--text); background: var(--muted-bg); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
            #cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 8px; margin: 12px 0; }
            .card { min-width: 0; padding: 10px; background: var(--muted-bg); border: 1px solid var(--border); border-radius: 8px; }
            .card span { display: block; color: var(--muted); margin-bottom: 4px; }
            .card strong { display: block; font-size: 17px; overflow-wrap: anywhere; }
            .card.latest { grid-column: span 2; }
            .card.latest strong { font-size: 13px; }
            .card.latest strong span { margin-top: 3px; }
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
          <button id="launcher" aria-controls="panel" aria-expanded="false" hidden>PR 统计</button>
          <section id="panel" hidden aria-label="GitHub PR 统计">
            <header>
              <h2 id="title">GitHub PR 统计</h2>
              <button id="close" title="关闭" aria-label="关闭">×</button>
            </header>
            <main>
              <div class="toolbar">
                <div class="scope" aria-label="统计范围">
                  <button id="scope-all">全部 PR</button>
                  <button id="scope-open" class="active">仅 Open</button>
                </div>
                <button id="analyze" class="button primary">开始分析</button>
              </div>
              <p id="status">尚未分析</p>
              <div id="cards"></div>
              <div class="table-wrap"><table id="table"></table></div>
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
                  GraphQL API 必须使用 Token。建议使用仅含仓库元数据和 Pull requests 只读权限的 fine-grained token。
                  Token 只保存在油猴扩展存储中，不会写入页面或仓库。
                </p>
              </details>
              <p class="help">
                中文判定：标题或原始正文任一处含中文。回复包含普通评论、review 和行内 review 回复；维护者指 OWNER、MEMBER 或 COLLABORATOR，并排除提交者本人和机器人。
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
            scopeAll: get("#scope-all"),
            scopeOpen: get("#scope-open"),
            status: get("#status"),
            log: get("#log"),
            cards: get("#cards"),
            table: get("#table"),
            settings: get("#settings"),
            tokenState: get("#token-state"),
            token: get("#token"),
            saveToken: get("#save-token"),
            clearToken: get("#clear-token"),
        };

        ui.launcher.addEventListener("click", () => {
            ui.panel.hidden = !ui.panel.hidden;
            ui.launcher.setAttribute(
                "aria-expanded",
                String(!ui.panel.hidden),
            );
            if (!ui.panel.hidden && !analyzedRows) runAnalysis();
        });
        ui.close.addEventListener("click", () => {
            ui.panel.hidden = true;
            ui.launcher.setAttribute("aria-expanded", "false");
        });
        ui.analyze.addEventListener("click", runAnalysis);
        ui.scopeAll.addEventListener("click", () => setScope("all"));
        ui.scopeOpen.addEventListener("click", () => setScope("open"));
        ui.saveToken.addEventListener("click", saveToken);
        ui.clearToken.addEventListener("click", clearToken);
        ui.token.addEventListener("keydown", (event) => {
            if (event.key === "Enter") saveToken();
        });
        updateTokenState();
    }

    function setScope(value) {
        if (loading || value === scope) return;
        scope = value;
        ui.scopeAll.classList.toggle("active", value === "all");
        ui.scopeOpen.classList.toggle("active", value === "open");
        if (
            analyzedRows &&
            (analyzedScope === "all" || analyzedScope === value)
        ) {
            render();
        } else if (!ui.panel.hidden) {
            runAnalysis();
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
        ui.title.textContent = `${repository.owner}/${repository.name} PR 统计`;
        if (changed) {
            analyzedRows = null;
            analyzedScope = null;
            overflowPrs = [];
            lastRateLimit = null;
            ui.log.textContent = "";
            ui.cards.innerHTML = "";
            ui.table.innerHTML = "";
            setStatus("尚未分析");
        }
    }

    if (typeof module === "object" && module.exports) {
        module.exports = {
            analyzePullRequest,
            classifyLanguage,
            formatRateLimit,
            rate,
            rateLimitFromHeaders,
            summarize,
        };
        return;
    }

    createUi();
    handleRouteChange();
    document.addEventListener("turbo:load", handleRouteChange);
    document.addEventListener("pjax:end", handleRouteChange);
    window.addEventListener("popstate", handleRouteChange);
})();
