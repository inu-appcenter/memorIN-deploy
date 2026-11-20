// node --test .github/scripts/project-sync.test.mjs 로 돌린다(CI "진행판 규칙 시험").
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATUS,
  issueFromBranch,
  linkedIssues,
  formAnswer,
  priorityFromForm,
  kindFromIssue,
  nextStatus,
  currentIteration,
  kstToday,
  planFromEvent,
  addNewIssue,
  syncIssues,
  checkProject,
  run,
} from "./project-sync.mjs";

test("브랜치 이름에서 이슈 번호", () => {
  assert.equal(issueFromBranch("fix/347-chat-membership"), 347);
  assert.equal(issueFromBranch("refs/heads/feat/19-pay"), 19);
  assert.equal(issueFromBranch("112-fix-session"), 112);
  assert.equal(issueFromBranch("fix/web-push-crypto-key-padding"), null);
  assert.equal(issueFromBranch("docs/contributing"), null);
  assert.equal(issueFromBranch("develop"), null);
  assert.equal(issueFromBranch(undefined), null);
});

test("PR이 다루는 이슈", () => {
  assert.deepEqual(linkedIssues({ body: "Closes #12" }), [12]);
  assert.deepEqual(linkedIssues({ body: "Fixes #1, #2 및 #3" }), [1, 2, 3]);
  assert.deepEqual(linkedIssues({ body: "refs: #7" }), [7]);
  assert.deepEqual(linkedIssues({ title: "fix: 무언가 (#60 1번)" }), [60]);
  assert.deepEqual(linkedIssues({ branch: "fix/347-x" }), [347]);
  // 안내 주석, 단순 언급, 다른 저장소 이슈는 세지 않음
  assert.deepEqual(linkedIssues({ body: "<!-- Closes #42 --> #9 참고. Closes inu-appcenter/memorIN-backend#5" }), []);
  assert.deepEqual(linkedIssues({ body: "- Closes #" }), []);
});

const form = (pairs) => pairs.map(([q, a]) => `### ${q}\n\n${a}`).join("\n\n");

test("이슈 양식의 답", () => {
  const body = form([["무슨 문제인가", "로그인 실패"], ["우선순위", "P1 - 높음: 이번 주 안"], ["참고", "_No response_"]]);
  assert.equal(formAnswer(body, "무슨 문제인가"), "로그인 실패");
  assert.equal(formAnswer(body, "참고"), "");
  assert.equal(formAnswer(body, "없는 질문"), "");
  assert.equal(priorityFromForm(body), "P1");
  assert.equal(priorityFromForm(form([["우선순위", "P0 - 긴급"]])), "P0");
  assert.equal(priorityFromForm("본문만 있음"), null);
});

test("종류: 양식 답이 먼저, 없으면 라벨", () => {
  assert.equal(kindFromIssue({ body: form([["종류", "운영 - 배포, 서버"]]), labels: ["bug"] }), "운영");
  assert.equal(kindFromIssue({ body: "", labels: [{ name: "bug" }] }), "버그");
  assert.equal(kindFromIssue({ body: "", labels: [{ name: "enhancement" }] }), "기능");
  assert.equal(kindFromIssue({ body: "", labels: ["documentation"] }), "유지보수");
  assert.equal(kindFromIssue({ body: "", labels: [] }), null);
});

test("칸 옮기기 규칙", () => {
  assert.equal(nextStatus(null, "branch"), STATUS.doing);
  assert.equal(nextStatus(STATUS.decide, "branch"), STATUS.doing);
  assert.equal(nextStatus(STATUS.review, "branch"), null);
  assert.equal(nextStatus(STATUS.todo, "pr_ready"), STATUS.review);
  assert.equal(nextStatus(STATUS.review, "pr_ready"), null);
  assert.equal(nextStatus(STATUS.review, "changes_requested"), STATUS.doing);
  assert.equal(nextStatus(STATUS.doing, "changes_requested"), null);
  assert.equal(nextStatus(STATUS.done, "pr_ready"), null);
});

test("주차와 서울 날짜", () => {
  const its = [{ id: "a", startDate: "2026-11-16", duration: 7 }, { id: "b", startDate: "2026-11-23", duration: 7 }];
  assert.equal(currentIteration(its, "2026-11-22")?.id, "a");
  assert.equal(currentIteration(its, "2026-11-23")?.id, "b");
  assert.equal(currentIteration(its, "2026-12-01"), null);
  // UTC 11-19 15:30은 서울 11-20 00:30
  assert.equal(kstToday(Date.parse("2026-11-19T15:30:00Z")), "2026-11-20");
});

test("이벤트를 할 일로", () => {
  assert.deepEqual(planFromEvent("issues", { action: "opened", issue: { number: 5, body: "b", labels: [] } }), {
    type: "new_issue", number: 5, body: "b", labels: [],
  });
  assert.equal(planFromEvent("issues", { action: "closed", issue: { number: 5 } }), null);
  assert.deepEqual(planFromEvent("create", { ref_type: "branch", ref: "fix/9-x" }), { type: "move", numbers: [9], event: "branch" });
  assert.equal(planFromEvent("create", { ref_type: "tag", ref: "v1" }), null);
  const pr = { title: "fix: x", body: "Closes #3", draft: false, head: { ref: "fix/x" } };
  assert.deepEqual(planFromEvent("pull_request", { action: "opened", pull_request: pr }), { type: "move", numbers: [3], event: "pr_ready" });
  assert.deepEqual(planFromEvent("pull_request", { action: "opened", pull_request: { ...pr, draft: true } }), { type: "move", numbers: [3], event: "pr_draft" });
  // 본문 수정: 새로 연결된 이슈만
  assert.equal(planFromEvent("pull_request", { action: "edited", pull_request: pr, changes: { body: { from: "Closes #3" } } }), null);
  assert.deepEqual(
    planFromEvent("pull_request", { action: "edited", pull_request: { ...pr, body: "Closes #3, #4" }, changes: { body: { from: "Closes #3" } } }),
    { type: "move", numbers: [4], event: "pr_ready" },
  );
  assert.deepEqual(
    planFromEvent("pull_request_review", { review: { state: "changes_requested" }, pull_request: pr }),
    { type: "move", numbers: [3], event: "changes_requested" },
  );
  assert.equal(planFromEvent("pull_request_review", { review: { state: "approved" }, pull_request: pr }), null);
});

// ---------- 진행판 GraphQL 흉내 ----------

const opts = (prefix, names) => names.map((name, i) => ({ id: `${prefix}${i}`, name }));
const PROJECT = {
  id: "P1",
  title: "memorIN 진행판",
  fields: {
    nodes: [
      { __typename: "ProjectV2SingleSelectField", id: "FS", name: "Status", options: opts("s", Object.values(STATUS)) },
      { __typename: "ProjectV2SingleSelectField", id: "FP", name: "우선순위", options: opts("p", ["P0 긴급", "P1 높음", "P2 보통", "P3 낮음"]) },
      { __typename: "ProjectV2SingleSelectField", id: "FK", name: "종류", options: opts("k", ["기능", "버그", "유지보수", "운영"]) },
      { __typename: "ProjectV2IterationField", id: "FW", name: "주차", configuration: { iterations: [{ id: "w1", startDate: "2026-11-16", duration: 7 }] } },
      { __typename: "ProjectV2Field", id: "FT", name: "Title" },
    ],
  },
};

function fakeGraphql({ issues = {}, project = PROJECT } = {}) {
  const calls = [];
  const graphql = async (query, vars) => {
    calls.push({ query, vars });
    if (query.includes("projectsV2")) return { organization: { projectsV2: { nodes: project ? [project] : [] } } };
    if (query.includes("issueOrPullRequest")) {
      const it = issues[vars.n];
      if (!it) throw new Error("not found");
      return { repository: { issueOrPullRequest: it } };
    }
    if (query.includes("addProjectV2ItemById")) return { addProjectV2ItemById: { item: { id: `item-${vars.c}` } } };
    if (query.includes("updateProjectV2ItemFieldValue")) return { updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.i } } };
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  };
  const writes = () => calls.filter((c) => c.query.startsWith("mutation")).map((c) => c.vars);
  return { graphql, writes };
}

const openIssue = (id, item = null) => ({
  __typename: "Issue",
  id,
  state: "OPEN",
  projectItems: { nodes: item ? [{ project: { id: "P1" }, ...item }] : [] },
});
const common = { org: "inu-appcenter", owner: "inu-appcenter", repo: "memorIN-backend", projectTitle: "memorIN 진행판" };

test("새 이슈: 진행판에 넣고 할 일, 우선순위, 종류", async () => {
  const { graphql, writes } = fakeGraphql({ issues: { 7: openIssue("I7") } });
  const lines = await addNewIssue({ graphql, ...common, number: 7, body: form([["우선순위", "P2 - 보통"]]), labels: [{ name: "bug" }] });
  assert.deepEqual(lines, ["#7: 진행판에 넣음", "#7: 할 일 칸으로", "#7: 우선순위 P2 보통", "#7: 종류 버그"]);
  assert.deepEqual(writes(), [
    { p: "P1", c: "I7" },
    { p: "P1", i: "item-I7", f: "FS", o: "s0" },
    { p: "P1", i: "item-I7", f: "FP", o: "p2" },
    { p: "P1", i: "item-I7", f: "FK", o: "k1" },
  ]);
});

test("새 이슈: 사람이 이미 정한 값은 그대로", async () => {
  const item = { id: "X", status: { name: STATUS.decide }, priority: { name: "P0 긴급" }, kind: { name: "운영" }, week: null };
  const { graphql, writes } = fakeGraphql({ issues: { 7: openIssue("I7", item) } });
  const lines = await addNewIssue({ graphql, ...common, number: 7, body: form([["우선순위", "P3 - 낮음"]]), labels: ["bug"] });
  assert.deepEqual(lines, []);
  assert.deepEqual(writes(), []);
});

test("브랜치: 진행 중과 이번 주차, 없는 번호와 닫힌 이슈는 건너뜀", async () => {
  const closed = { ...openIssue("I8"), state: "CLOSED" };
  const { graphql, writes } = fakeGraphql({ issues: { 7: openIssue("I7", { id: "X", status: { name: STATUS.todo } }), 8: closed } });
  const lines = await syncIssues({ graphql, ...common, numbers: [7, 8, 1119], event: "branch", today: "2026-11-20" });
  assert.deepEqual(lines, ["#7: 할 일 칸에서 진행 중 칸으로", "#7: 주차를 2026-11-16 주로"]);
  assert.deepEqual(writes(), [
    { p: "P1", i: "X", f: "FS", o: "s1" },
    { p: "P1", i: "X", f: "FW", o: "w1" },
  ]);
});

test("PR: 진행판에 없던 이슈는 넣고 리뷰 중으로", async () => {
  const { graphql } = fakeGraphql({ issues: { 3: openIssue("I3") } });
  const lines = await syncIssues({ graphql, ...common, numbers: [3], event: "pr_ready", today: "2026-11-20" });
  assert.deepEqual(lines, ["#3: 진행판에 넣음", "#3: 리뷰 중 칸으로"]);
});

test("진행판을 찾지 못하면 아무것도 하지 않음", async () => {
  const { graphql, writes } = fakeGraphql({ project: null, issues: { 3: openIssue("I3") } });
  assert.deepEqual(await syncIssues({ graphql, ...common, numbers: [3], event: "pr_ready", today: "2026-11-20" }), []);
  assert.deepEqual(writes(), []);
  const lines = await checkProject({ graphql, org: "inu-appcenter", projectTitle: "memorIN 진행판", today: "2026-11-20" });
  assert.match(lines[0], /찾지 못했어요/);
});

test("점검: 필드와 이번 주차", async () => {
  const { graphql } = fakeGraphql();
  const lines = await checkProject({ graphql, org: "inu-appcenter", projectTitle: "memorIN 진행판", today: "2026-11-20" });
  assert.deepEqual(lines, [
    "진행판 찾음: memorIN 진행판",
    `Status 칸: ${Object.values(STATUS).join(", ")}`,
    "필요한 칸이 모두 있어요",
    "우선순위: P0 긴급, P1 높음, P2 보통, P3 낮음",
    "종류: 기능, 버그, 유지보수, 운영",
    "이번 주차: 2026-11-16부터 7일",
  ]);
});

function fakeCore() {
  const log = { info: [], notice: [], failed: [] };
  const summary = { addHeading: () => summary, addList: () => summary, addRaw: () => summary, write: async () => {} };
  return {
    log,
    core: {
      info: (m) => log.info.push(m),
      notice: (m) => log.notice.push(m),
      setFailed: (m) => log.failed.push(m),
      summary,
    },
  };
}

test("진입점: 토큰이 없으면 건너뛰고 실패로 표시하지 않음", async () => {
  const { graphql, writes } = fakeGraphql({ issues: { 5: openIssue("I5") } });
  const { core, log } = fakeCore();
  const context = { repo: { owner: "inu-appcenter", repo: "memorIN-frontend" }, eventName: "issues", payload: { action: "opened", issue: { number: 5, body: "", labels: [] } } };
  await run({ github: { graphql }, context, core, projectTitle: "memorIN 진행판", hasToken: false, today: "2026-11-20" });
  assert.equal(log.notice.length, 1);
  assert.equal(log.failed.length, 0);
  assert.deepEqual(writes(), []);
});

test("진입점: 점검 실행은 토큰이 없으면 실패", async () => {
  const { graphql } = fakeGraphql();
  const { core, log } = fakeCore();
  const context = { repo: { owner: "inu-appcenter", repo: "memorIN-deploy" }, eventName: "workflow_dispatch", payload: {} };
  await run({ github: { graphql }, context, core, projectTitle: "memorIN 진행판", hasToken: false });
  assert.equal(log.failed.length, 1);
});

test("진입점: 새 이슈를 넣음", async () => {
  const { graphql } = fakeGraphql({ issues: { 5: openIssue("I5") } });
  const { core, log } = fakeCore();
  const context = { repo: { owner: "inu-appcenter", repo: "memorIN-frontend" }, eventName: "issues", payload: { action: "opened", issue: { number: 5, body: form([["우선순위", "P1 - 높음"]]), labels: [{ name: "enhancement" }] } } };
  await run({ github: { graphql }, context, core, projectTitle: "memorIN 진행판", hasToken: true, today: "2026-11-20" });
  assert.match(log.info.at(-1), /#5: 진행판에 넣음\n#5: 할 일 칸으로\n#5: 우선순위 P1 높음\n#5: 종류 기능/);
});
