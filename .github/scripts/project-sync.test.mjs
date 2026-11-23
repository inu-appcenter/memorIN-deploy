// node --test .github/scripts/project-sync.test.mjs 로 돌린다(CI "진행판 규칙 시험").
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATUS,
  issueFromBranch,
  linkedIssues,
  closingIssues,
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
  closeMerged,
  parseTriage,
  applyTriage,
  runTriage,
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
  // 리뷰 중인 PR을 초안으로 되돌림
  assert.equal(nextStatus(STATUS.review, "pr_draft"), STATUS.doing);
  assert.equal(nextStatus(STATUS.doing, "pr_draft"), null);
  // 이슈를 닫지 않고 끝난 PR
  assert.equal(nextStatus(STATUS.review, "pr_closed"), STATUS.doing);
  assert.equal(nextStatus(STATUS.todo, "pr_closed"), null);
  assert.equal(nextStatus(STATUS.done, "pr_closed"), null);
});

test("이슈를 닫는 키워드만", () => {
  assert.deepEqual(closingIssues("Closes #1, #2\nFixes #3\nresolved #4"), [1, 2, 3, 4]);
  assert.deepEqual(closingIssues("Refs #5\n#6 참고\n<!-- Closes #7 -->\nCloses inu-appcenter/memorIN-deploy#8"), []);
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

test("PR이 닫힐 때", () => {
  const repository = { default_branch: "main" };
  const pr = (o) => ({ title: "fix: x", body: "Closes #3\nRefs #9", draft: false, head: { ref: "fix/12-x" }, base: { ref: "develop" }, merged: true, ...o });
  // develop 병합: Closes는 닫고, Refs와 브랜치 번호는 "리뷰 중"이면 되돌림
  assert.deepEqual(planFromEvent("pull_request", { action: "closed", repository, pull_request: pr() }), { type: "pr_closed", close: [3], back: [9, 12] });
  // main 병합: Closes는 GitHub이 닫으므로 건드리지 않음
  assert.deepEqual(planFromEvent("pull_request", { action: "closed", repository, pull_request: pr({ base: { ref: "main" } }) }), { type: "pr_closed", close: [], back: [9, 12] });
  // 병합 없이 닫음: 모두 되돌림
  assert.deepEqual(planFromEvent("pull_request", { action: "closed", repository, pull_request: pr({ merged: false }) }), { type: "pr_closed", close: [], back: [3, 9, 12] });
  // 연결된 이슈가 없음
  assert.equal(planFromEvent("pull_request", { action: "closed", repository, pull_request: pr({ body: "", head: { ref: "fix/x" } }) }), null);
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
  assert.deepEqual(lines, ["#3: 진행판에 넣음", "#3: 리뷰 중 칸으로", "#3: 주차를 2026-11-16 주로"]);
});

test("진행판을 찾지 못하면 아무것도 하지 않음", async () => {
  const { graphql, writes } = fakeGraphql({ project: null, issues: { 3: openIssue("I3") } });
  assert.deepEqual(await syncIssues({ graphql, ...common, numbers: [3], event: "pr_ready", today: "2026-11-20" }), []);
  assert.deepEqual(writes(), []);
  const { lines, problems } = await checkProject({ graphql, org: "inu-appcenter", projectTitle: "memorIN 진행판", today: "2026-11-20" });
  assert.match(lines[0], /찾지 못했어요/);
  assert.equal(problems.length, 1);
});

test("점검: 필드와 이번 주차, 주차가 곧 끝나면 고칠 것", async () => {
  const { graphql } = fakeGraphql();
  const { lines, problems } = await checkProject({ graphql, org: "inu-appcenter", projectTitle: "memorIN 진행판", today: "2026-11-20" });
  assert.deepEqual(lines, [
    "진행판 찾음: memorIN 진행판",
    `Status 칸: ${Object.values(STATUS).join(", ")}`,
    "필요한 칸이 모두 있어요",
    "우선순위: P0 긴급, P1 높음, P2 보통, P3 낮음",
    "종류: 기능, 버그, 유지보수, 운영",
    "이번 주차: 2026-11-16부터 7일",
    "고칠 것: 주차가 3일 뒤에 끝나요(진행판 Settings > 주차 > Add iteration)",
  ]);
  assert.equal(problems.length, 1);
});

test("점검: 주차가 넉넉하면 문제 없음, 오늘 주차가 없으면 고칠 것", async () => {
  const weeks = Array.from({ length: 8 }, (_, i) => ({ id: `w${i}`, startDate: new Date(Date.UTC(2026, 10, 16 + 7 * i)).toISOString().slice(0, 10), duration: 7 }));
  const project = { ...PROJECT, fields: { nodes: PROJECT.fields.nodes.map((f) => (f.name === "주차" ? { ...f, configuration: { iterations: weeks } } : f)) } };
  const ok = await checkProject({ graphql: fakeGraphql({ project }).graphql, org: "o", projectTitle: "memorIN 진행판", today: "2026-11-20" });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.lines.at(-1), "등록된 주차는 52일 뒤까지");
  const late = await checkProject({ graphql: fakeGraphql({ project }).graphql, org: "o", projectTitle: "memorIN 진행판", today: "2027-03-01" });
  assert.deepEqual(late.problems, ["오늘이 들어 있는 주차가 없어요(진행판 Settings > 주차 > Add iteration)"]);
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

// ---------- 분류 일괄 적용 ----------

test("일괄 분류 입력 검사", () => {
  assert.match(parseTriage("{").errors[0], /JSON을 읽지 못했어요/);
  assert.deepEqual(parseTriage("{}").errors, ["입력은 배열([...])이어야 해요"]);
  const { items, errors } = parseTriage(JSON.stringify([
    { repo: "memorIN-backend", number: 346, priority: "P1", week: "current" },
    { repo: "other-repo", number: 1 },
    { repo: "memorIN-frontend", number: "x" },
    { repo: "memorIN-deploy", number: 8, week: "next" },
  ]));
  assert.deepEqual(items, [{ repo: "memorIN-backend", number: 346, status: null, priority: "P1", kind: null, week: "current" }]);
  assert.equal(errors.length, 3);
});

test("일괄 분류: 시험 실행은 바꾸지 않고 바뀔 내용만", async () => {
  const item = { id: "X", status: { name: STATUS.todo }, priority: null, kind: { name: "버그" }, week: null };
  const { graphql, writes } = fakeGraphql({ issues: { 111: openIssue("I111", item), 86: openIssue("I86") } });
  const items = [
    { repo: "memorIN-frontend", number: 111, status: "할 일", priority: "P1", kind: "버그", week: "current" },
    { repo: "memorIN-frontend", number: 86, status: "보류", priority: "P3", kind: "기능", week: null },
    { repo: "memorIN-frontend", number: 999, status: "할 일", priority: null, kind: null, week: null },
  ];
  const { lines, problems } = await applyTriage({ graphql, org: "inu-appcenter", projectTitle: "memorIN 진행판", items, today: "2026-11-20" });
  assert.deepEqual(lines, [
    "FE #111: 우선순위 (없음) → P1 높음, 주차 → 2026-11-16 주",
    "FE #86: 진행판에 넣음, Status (없음) → 보류, 우선순위 (없음) → P3 낮음, 종류 (없음) → 기능",
    "FE #999: 열린 이슈가 아니라 건너뜀",
  ]);
  assert.equal(problems, 0);
  assert.deepEqual(writes(), []);
});

test("일괄 분류: 적용", async () => {
  const item = { id: "X", status: { name: STATUS.todo }, priority: null, kind: { name: "버그" }, week: null };
  const { graphql, writes } = fakeGraphql({ issues: { 111: openIssue("I111", item), 86: openIssue("I86") } });
  const items = [
    { repo: "memorIN-frontend", number: 111, status: "할 일", priority: "P1", kind: "버그", week: "current" },
    { repo: "memorIN-frontend", number: 86, status: "보류", priority: null, kind: null, week: null },
  ];
  await applyTriage({ graphql, org: "inu-appcenter", projectTitle: "memorIN 진행판", items, today: "2026-11-20", apply: true });
  assert.deepEqual(writes(), [
    { p: "P1", i: "X", f: "FP", o: "p1" },
    { p: "P1", i: "X", f: "FW", o: "w1" },
    { p: "P1", c: "I86" },
    { p: "P1", i: "item-I86", f: "FS", o: "s4" },
  ]);
});

test("일괄 분류: 없는 선택지와 주차는 문제로 세고 그 칸만 건너뜀", async () => {
  const { graphql, writes } = fakeGraphql({ issues: { 5: openIssue("I5", { id: "X", status: { name: STATUS.todo } }) } });
  const items = [{ repo: "memorIN-deploy", number: 5, status: "검토", priority: "P2", kind: null, week: "current" }];
  const { lines, problems } = await applyTriage({ graphql, org: "inu-appcenter", projectTitle: "memorIN 진행판", items, today: "2027-01-01", apply: true });
  assert.deepEqual(lines, ['deploy #5: 우선순위 (없음) → P2 보통, Status "검토" 선택지가 없음, 주차: 오늘이 들어 있는 주차가 없음']);
  assert.equal(problems, 2);
  assert.deepEqual(writes(), [{ p: "P1", i: "X", f: "FP", o: "p2" }]);
});

test("일괄 분류 진입점: 입력 오류와 토큰 없음은 실패", async () => {
  const { graphql } = fakeGraphql();
  const a = fakeCore();
  await runTriage({ github: { graphql }, core: a.core, org: "inu-appcenter", projectTitle: "memorIN 진행판", text: "[{}]", apply: false, hasToken: true });
  assert.match(a.log.failed[0], /입력을 고쳐 주세요/);
  const b = fakeCore();
  await runTriage({ github: { graphql }, core: b.core, org: "inu-appcenter", projectTitle: "memorIN 진행판", text: '[{"repo":"memorIN-deploy","number":1}]', apply: false, hasToken: false });
  assert.match(b.log.failed[0], /토큰이 없어요/);
});

// ---------- develop 병합으로 이슈 닫기 ----------

function fakeIssueApi({ fail = false } = {}) {
  const closed = [];
  return {
    closed,
    rest: {
      issues: {
        update: async (args) => {
          if (fail) throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
          closed.push(args);
        },
      },
    },
  };
}

test("develop 병합: 완료로 옮기고 이슈를 닫음, 이미 닫힌 이슈는 건너뜀", async () => {
  const closedIssue = { ...openIssue("I8"), state: "CLOSED" };
  const { graphql, writes } = fakeGraphql({ issues: { 7: openIssue("I7", { id: "X", status: { name: STATUS.review } }), 8: closedIssue } });
  const issueApi = fakeIssueApi();
  const lines = await closeMerged({ graphql, issueApi, ...common, numbers: [7, 8], prNumber: 360 });
  assert.deepEqual(lines, ["#7: 리뷰 중 칸에서 완료 칸으로(#360 병합)", "#7: 이슈 닫음"]);
  assert.deepEqual(writes(), [{ p: "P1", i: "X", f: "FS", o: "s5" }]);
  assert.deepEqual(issueApi.closed, [{ owner: "inu-appcenter", repo: "memorIN-backend", issue_number: 7, state: "closed", state_reason: "completed" }]);
});

test("develop 병합: 이슈를 닫지 못해도 칸은 완료로 두고 이유를 남김", async () => {
  const { graphql } = fakeGraphql({ issues: { 7: openIssue("I7", { id: "X", status: { name: STATUS.review } }) } });
  const lines = await closeMerged({ graphql, issueApi: fakeIssueApi({ fail: true }), ...common, numbers: [7], prNumber: 360 });
  assert.equal(lines[0], "#7: 리뷰 중 칸에서 완료 칸으로(#360 병합)");
  assert.match(lines[1], /이슈를 닫지 못함\(403/);
});

test("진입점: develop에 병합된 PR", async () => {
  const { graphql, writes } = fakeGraphql({
    issues: { 7: openIssue("I7", { id: "X", status: { name: STATUS.review } }), 9: openIssue("I9", { id: "Y", status: { name: STATUS.review } }) },
  });
  const issueApi = fakeIssueApi();
  const { core, log } = fakeCore();
  const context = {
    repo: { owner: "inu-appcenter", repo: "memorIN-backend" },
    eventName: "pull_request",
    payload: {
      action: "closed",
      repository: { default_branch: "main" },
      pull_request: { number: 360, title: "fix: x", body: "Closes #7\nRefs #9", merged: true, draft: false, head: { ref: "fix/x" }, base: { ref: "develop" } },
    },
  };
  await run({ github: { graphql }, context, core, projectTitle: "memorIN 진행판", hasToken: true, issueApi, today: "2026-11-20" });
  assert.equal(log.failed.length, 0);
  assert.deepEqual(issueApi.closed.map((c) => c.issue_number), [7]);
  assert.deepEqual(writes(), [
    { p: "P1", i: "X", f: "FS", o: "s5" },
    { p: "P1", i: "Y", f: "FS", o: "s1" },
  ]);
});

test("진입점: 정기 점검은 고칠 것이 있으면 실패", async () => {
  const { graphql } = fakeGraphql();
  const { core, log } = fakeCore();
  const context = { repo: { owner: "inu-appcenter", repo: "memorIN-deploy" }, eventName: "schedule", payload: {} };
  await run({ github: { graphql }, context, core, projectTitle: "memorIN 진행판", hasToken: true, today: "2026-11-20" });
  assert.match(log.failed[0], /주차가 3일 뒤에 끝나요/);
});
