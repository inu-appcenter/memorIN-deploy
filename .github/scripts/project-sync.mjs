// memorIN 진행판(inu-appcenter 조직 Projects "memorIN 진행판") 자동 정리 규칙.
// .github/workflows/project-sync.yml(공용)이 부르고, project-sync.test.mjs가 시험한다.
// 저장소 3개(backend, frontend, deploy)의 .github/workflows/project.yml이 공용 워크플로를 호출한다.
// 진행판 기본 Workflows(닫힌 이슈를 "완료"로 등)로 안 되는 것만 맡는다.

/** 진행판 필드 이름(진행판과 같아야 함) */
export const FIELD = {
  status: "Status",
  priority: "우선순위",
  kind: "종류",
  week: "주차",
};

/** Status 칸 이름(진행판과 같아야 함) */
export const STATUS = {
  todo: "할 일",
  doing: "진행 중",
  review: "리뷰 중",
  decide: "결정 대기",
  hold: "보류",
  done: "완료",
};

/** 아직 시작 전으로 보는 칸: 여기서만 "진행 중"으로 올린다 */
const NOT_STARTED = new Set([STATUS.todo, STATUS.decide, STATUS.hold]);

/** 라벨로 "종류"를 고를 때 쓰는 표. 이슈 양식의 "종류" 답이 있으면 그쪽이 먼저다 */
const KIND_BY_LABEL = {
  bug: "버그",
  security: "버그",
  enhancement: "기능",
  documentation: "유지보수",
  dependencies: "유지보수",
};

/**
 * 브랜치 이름의 이슈 번호.
 *  - <종류>/<번호>-설명: fix/347-chat-membership
 *  - <번호>-설명: 112-fix-session (이슈 화면의 "Create a branch"가 만드는 이름)
 * 날짜를 붙인 브랜치(feat/1119-...)도 숫자가 나오지만, 그런 번호의 열린 이슈가 없으면 쓰는 쪽에서 버린다.
 */
export function issueFromBranch(ref) {
  const m = /^(?:refs\/heads\/)?(?:[a-z]+\/)?(\d{1,5})-/.exec(typeof ref === "string" ? ref : "");
  return m ? Number(m[1]) : null;
}

/**
 * PR이 다루는 같은 저장소의 이슈 번호들.
 *  - 본문: Closes, Fixes, Resolves, Refs #번호 (여러 개면 "#1, #2" "#1 및 #2")
 *  - 제목: (#번호 ...) 꼴
 *  - 브랜치 이름의 번호
 * 템플릿 안내 주석(<!-- -->) 속 예시, 그냥 "#번호"라고 언급만 한 것, 다른 저장소 이슈(owner/repo#번호)는 세지 않는다.
 */
export function linkedIssues({ title = "", body = "", branch = "" } = {}) {
  const out = new Set();
  const text = String(body ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const kw = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b\s*:?\s*(#\d+(?:\s*(?:,|and|및)\s*#\d+)*)/gi;
  for (const m of text.matchAll(kw)) for (const n of m[1].matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  for (const m of String(title ?? "").matchAll(/\(#(\d+)\b/g)) out.add(Number(m[1]));
  const b = issueFromBranch(branch);
  if (b) out.add(b);
  return [...out];
}

/** 이슈 양식의 답(### 질문 다음 줄). 없거나 "_No response_"면 "" */
export function formAnswer(body, label) {
  const text = typeof body === "string" ? body : "";
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const answer = new RegExp(`^###\\s*${escaped}\\s*\\n+\\s*([^\\n]+)`, "m").exec(text)?.[1]?.trim() ?? "";
  return answer === "_No response_" ? "" : answer;
}

/** 양식의 "우선순위" 답(P0 - 긴급 ...)에서 P0~P3. 없으면 null */
export function priorityFromForm(body) {
  const m = /^P([0-3])\b/.exec(formAnswer(body, "우선순위"));
  return m ? `P${m[1]}` : null;
}

/** "종류": 양식의 "종류" 답이 먼저, 없으면 라벨. 없으면 null */
export function kindFromIssue({ body = "", labels = [] } = {}) {
  const answer = formAnswer(body, "종류");
  for (const k of ["기능", "버그", "유지보수", "운영"]) if (answer.startsWith(k)) return k;
  const names = (labels ?? []).map((l) => String(typeof l === "string" ? l : l?.name ?? "").toLowerCase());
  for (const name of names) if (KIND_BY_LABEL[name]) return KIND_BY_LABEL[name];
  return null;
}

/**
 * 일이 생겼을 때 지금 칸에서 옮길 칸. 그대로 두면 null.
 *  - branch: 이슈 번호가 든 브랜치를 처음 올림. 시작 전이면 "진행 중"
 *  - pr_draft: 초안 PR. 시작 전이면 "진행 중"
 *  - pr_ready: 리뷰를 받을 PR(열기, 초안 해제, 리뷰 요청). "리뷰 중"
 *  - changes_requested: 수정 요청 리뷰. "리뷰 중"이면 "진행 중"
 * "완료" 칸은 건드리지 않는다(닫힌 이슈는 기본 Workflows가 맡음).
 */
export function nextStatus(current, event) {
  const cur = current || STATUS.todo;
  if (cur === STATUS.done) return null;
  if (event === "branch" || event === "pr_draft") return NOT_STARTED.has(cur) ? STATUS.doing : null;
  if (event === "pr_ready") return cur === STATUS.review ? null : STATUS.review;
  if (event === "changes_requested") return cur === STATUS.review ? STATUS.doing : null;
  return null;
}

/** 서울 날짜(YYYY-MM-DD) */
export function kstToday(now = Date.now()) {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 오늘이 들어 있는 반복 주기("주차"). 없으면 null */
export function currentIteration(iterations, today) {
  const day = Date.parse(`${today}T00:00:00Z`);
  for (const it of iterations ?? []) {
    const start = Date.parse(`${it.startDate}T00:00:00Z`);
    if (day >= start && day < start + it.duration * 86_400_000) return it;
  }
  return null;
}

/**
 * 이벤트를 할 일로 바꾼다. 할 일이 없으면 null.
 *  - { type: "new_issue", number, body, labels }
 *  - { type: "move", numbers, event }
 */
export function planFromEvent(eventName, payload) {
  const ev = payload ?? {};
  if (eventName === "issues" && ev.action === "opened" && ev.issue && !ev.issue.pull_request) {
    return { type: "new_issue", number: ev.issue.number, body: ev.issue.body ?? "", labels: ev.issue.labels ?? [] };
  }
  if (eventName === "create") {
    if (ev.ref_type !== "branch") return null;
    const n = issueFromBranch(ev.ref);
    return n ? { type: "move", numbers: [n], event: "branch" } : null;
  }
  if (eventName === "pull_request" && ev.pull_request) {
    const pr = ev.pull_request;
    let numbers = linkedIssues({ title: pr.title, body: pr.body, branch: pr.head?.ref });
    // 본문이나 제목을 고친 경우에는 새로 연결된 이슈만(수정 중인 이슈를 "리뷰 중"으로 되돌리지 않게)
    if (ev.action === "edited") {
      const before = linkedIssues({
        title: ev.changes?.title?.from ?? pr.title,
        body: ev.changes?.body?.from ?? pr.body,
        branch: pr.head?.ref,
      });
      numbers = numbers.filter((n) => !before.includes(n));
    }
    if (!numbers.length) return null;
    return { type: "move", numbers, event: pr.draft ? "pr_draft" : "pr_ready" };
  }
  if (eventName === "pull_request_review" && ev.review?.state === "changes_requested" && ev.pull_request) {
    const pr = ev.pull_request;
    const numbers = linkedIssues({ title: pr.title, body: pr.body, branch: pr.head?.ref });
    return numbers.length ? { type: "move", numbers, event: "changes_requested" } : null;
  }
  return null;
}

// ---------- 진행판 읽기와 쓰기(GraphQL) ----------

const PROJECT_QUERY = `query($org:String!,$q:String!){organization(login:$org){projectsV2(first:20,query:$q){nodes{id title fields(first:50){nodes{__typename ... on ProjectV2FieldCommon{id name} ... on ProjectV2SingleSelectField{options{id name}} ... on ProjectV2IterationField{configuration{iterations{id startDate duration}}}}}}}}}`;

const ITEM_QUERY = `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issueOrPullRequest(number:$n){__typename ... on Issue{id state projectItems(first:20){nodes{id project{id} status:fieldValueByName(name:"${FIELD.status}"){... on ProjectV2ItemFieldSingleSelectValue{name}} priority:fieldValueByName(name:"${FIELD.priority}"){... on ProjectV2ItemFieldSingleSelectValue{name}} kind:fieldValueByName(name:"${FIELD.kind}"){... on ProjectV2ItemFieldSingleSelectValue{name}} week:fieldValueByName(name:"${FIELD.week}"){... on ProjectV2ItemFieldIterationValue{iterationId}}}}}}}}`;

const ADD_ITEM = `mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}`;
const SET_SELECT = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}`;
const SET_ITERATION = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{iterationId:$o}}){projectV2Item{id}}}`;

/** 단일 선택 필드에서 이름이 value로 시작하는 선택지(예: "P1"은 "P1 높음"과 맞음) */
function findOption(field, value) {
  if (!field || !value) return null;
  return field.options.find((o) => o.name === value) ?? field.options.find((o) => o.name.startsWith(value)) ?? null;
}

async function findProject(graphql, org, title) {
  const r = await graphql(PROJECT_QUERY, { org, q: title });
  const p = r.organization?.projectsV2?.nodes?.find((x) => x?.title === title);
  if (!p) return null;
  const fields = p.fields.nodes.filter(Boolean);
  const select = (name) => fields.find((f) => f.name === name && Array.isArray(f.options)) ?? null;
  return {
    id: p.id,
    status: select(FIELD.status),
    priority: select(FIELD.priority),
    kind: select(FIELD.kind),
    week: fields.find((f) => f.name === FIELD.week && f.configuration) ?? null,
  };
}

/** 이슈와 진행판 항목. 없는 번호, PR 번호, 닫힌 이슈는 null */
async function findIssue(graphql, owner, repo, n, projectId) {
  let r;
  try {
    r = await graphql(ITEM_QUERY, { owner, repo, n });
  } catch {
    return null; // 그런 번호가 없음(날짜를 붙인 브랜치 등)
  }
  const issue = r.repository?.issueOrPullRequest;
  if (!issue || issue.__typename !== "Issue" || issue.state !== "OPEN") return null;
  const item = issue.projectItems.nodes.find((x) => x?.project?.id === projectId) ?? null;
  return {
    id: issue.id,
    item: item && {
      id: item.id,
      status: item.status?.name ?? null,
      priority: item.priority?.name ?? null,
      kind: item.kind?.name ?? null,
      iteration: item.week?.iterationId ?? null,
    },
  };
}

async function ensureItem(graphql, project, issue) {
  if (issue.item) return { item: issue.item, added: false };
  const r = await graphql(ADD_ITEM, { p: project.id, c: issue.id });
  return { item: { id: r.addProjectV2ItemById.item.id, status: null, priority: null, kind: null, iteration: null }, added: true };
}

async function setSelect(graphql, project, field, itemId, optionId) {
  await graphql(SET_SELECT, { p: project.id, i: itemId, f: field.id, o: optionId });
}

/**
 * 토큰과 진행판 설정 점검(아무것도 바꾸지 않음). 사람이 읽는 줄들을 돌려준다.
 */
export async function checkProject({ graphql, org, projectTitle, today }) {
  const project = await findProject(graphql, org, projectTitle);
  if (!project) return [`진행판 "${projectTitle}"을 찾지 못했어요(App 설치, Projects 권한, 이름 확인)`];
  const names = project.status?.options.map((o) => o.name) ?? [];
  const missing = Object.values(STATUS).filter((s) => !names.includes(s));
  const it = project.week ? currentIteration(project.week.configuration.iterations, today) : null;
  const optionList = (f) => (f ? f.options.map((o) => o.name).join(", ") : "");
  return [
    `진행판 찾음: ${projectTitle}`,
    project.status ? `Status 칸: ${names.join(", ")}` : "Status 칸이 없어요",
    missing.length ? `없는 칸(이 칸으로는 옮기지 못함): ${missing.join(", ")}` : "필요한 칸이 모두 있어요",
    project.priority ? `${FIELD.priority}: ${optionList(project.priority)}` : `"${FIELD.priority}" 필드가 없어요(우선순위 넣기는 건너뜀)`,
    project.kind ? `${FIELD.kind}: ${optionList(project.kind)}` : `"${FIELD.kind}" 필드가 없어요(종류 넣기는 건너뜀)`,
    !project.week ? `"${FIELD.week}" 필드가 없어요(주차 넣기는 건너뜀)` : it ? `이번 주차: ${it.startDate}부터 ${it.duration}일` : "오늘이 들어 있는 주차가 없어요",
  ];
}

/**
 * 새 이슈를 진행판에 넣고, 비어 있는 칸만 채운다(Status "할 일", 양식의 우선순위, 종류).
 * 사람이 이미 정한 값은 바꾸지 않는다.
 */
export async function addNewIssue({ graphql, org, owner, repo, projectTitle, number, body, labels, log = () => {} }) {
  const project = await findProject(graphql, org, projectTitle);
  if (!project) {
    log(`진행판 "${projectTitle}"을 찾지 못했어요(토큰 권한 또는 이름 확인)`);
    return [];
  }
  const issue = await findIssue(graphql, owner, repo, number, project.id);
  if (!issue) return [];
  const { item, added } = await ensureItem(graphql, project, issue);
  const done = added ? [`#${number}: 진행판에 넣음`] : [];

  const todo = !item.status && findOption(project.status, STATUS.todo);
  if (todo) {
    await setSelect(graphql, project, project.status, item.id, todo.id);
    done.push(`#${number}: ${STATUS.todo} 칸으로`);
  }
  const priority = !item.priority && findOption(project.priority, priorityFromForm(body));
  if (priority) {
    await setSelect(graphql, project, project.priority, item.id, priority.id);
    done.push(`#${number}: ${FIELD.priority} ${priority.name}`);
  }
  const kind = !item.kind && findOption(project.kind, kindFromIssue({ body, labels }));
  if (kind) {
    await setSelect(graphql, project, project.kind, item.id, kind.id);
    done.push(`#${number}: ${FIELD.kind} ${kind.name}`);
  }
  return done;
}

/**
 * 이슈들을 진행판에서 옮긴다. 진행판에 없으면 넣는다. 옮긴 내용을 사람이 읽는 줄로 돌려준다.
 */
export async function syncIssues({ graphql, org, owner, repo, projectTitle, numbers, event, today, log = () => {} }) {
  const project = await findProject(graphql, org, projectTitle);
  if (!project) {
    log(`진행판 "${projectTitle}"을 찾지 못했어요(토큰 권한 또는 이름 확인)`);
    return [];
  }
  const done = [];
  for (const n of numbers) {
    const issue = await findIssue(graphql, owner, repo, n, project.id);
    if (!issue) continue;
    const { item, added } = await ensureItem(graphql, project, issue);
    if (added) done.push(`#${n}: 진행판에 넣음`);
    const next = nextStatus(item.status, event);
    const opt = next && findOption(project.status, next);
    if (opt) {
      await setSelect(graphql, project, project.status, item.id, opt.id);
      done.push(item.status ? `#${n}: ${item.status} 칸에서 ${next} 칸으로` : `#${n}: ${next} 칸으로`);
    }
    // 처음 시작할 때 "주차"가 비어 있으면 이번 주로
    if (project.week && !item.iteration && (event === "branch" || event === "pr_draft")) {
      const it = currentIteration(project.week.configuration.iterations, today);
      if (it) {
        await graphql(SET_ITERATION, { p: project.id, i: item.id, f: project.week.id, o: it.id });
        done.push(`#${n}: ${FIELD.week}를 ${it.startDate} 주로`);
      }
    }
  }
  return done;
}

/**
 * 공용 워크플로의 진입점. actions/github-script의 github, context, core를 받는다.
 * 토큰이 없으면 실패로 표시하지 않고 건너뛴다(점검 실행만 실패로 표시).
 */
export async function run({ github, context, core, projectTitle, hasToken, today = kstToday() }) {
  const { owner, repo } = context.repo;
  const org = owner;

  if (context.eventName === "workflow_dispatch") {
    if (!hasToken) return core.setFailed("진행판 토큰이 없어요. 변수 PROJECT_APP_ID와 비밀값 PROJECT_APP_PRIVATE_KEY(또는 PROJECT_TOKEN)를 확인해 주세요");
    const lines = await checkProject({ graphql: github.graphql, org, projectTitle, today });
    core.info(lines.join("\n"));
    await core.summary.addHeading("진행판 점검", 3).addList(lines).write();
    if (lines[0].includes("찾지 못했어요")) core.setFailed(lines[0]);
    return;
  }

  const plan = planFromEvent(context.eventName, context.payload);
  if (!plan) return core.info("진행판에서 바꿀 것이 없습니다");
  if (!hasToken) return core.notice("진행판 토큰이 없어 건너뜁니다(memorIN-deploy의 .github/workflows/project-sync.yml 맨 위 설명 참고)");

  const common = { graphql: github.graphql, org, owner, repo, projectTitle, log: core.info };
  const lines =
    plan.type === "new_issue"
      ? await addNewIssue({ ...common, number: plan.number, body: plan.body, labels: plan.labels })
      : await syncIssues({ ...common, numbers: plan.numbers, event: plan.event, today });
  core.info(lines.length ? lines.join("\n") : "바꿀 칸이 없습니다");
  if (lines.length) await core.summary.addList(lines).write();
}

// ---------- 분류 일괄 적용(.github/workflows/project-triage.yml) ----------

/** 일괄 분류로 바꿀 수 있는 저장소 */
export const TRIAGE_REPOS = ["memorIN-backend", "memorIN-frontend", "memorIN-deploy"];

const SHORT_REPO = { "memorIN-backend": "BE", "memorIN-frontend": "FE", "memorIN-deploy": "deploy" };

/**
 * 일괄 분류 입력(JSON 배열)을 읽는다. 잘못된 줄은 errors에 모은다.
 * 한 줄: { repo, number, status?, priority?, kind?, week? }  week는 "current"(이번 주차)만 받는다.
 */
export function parseTriage(text) {
  let raw;
  try {
    raw = JSON.parse(String(text ?? ""));
  } catch (e) {
    return { items: [], errors: [`JSON을 읽지 못했어요: ${e.message}`] };
  }
  if (!Array.isArray(raw)) return { items: [], errors: ["입력은 배열([...])이어야 해요"] };
  const items = [];
  const errors = [];
  raw.forEach((r, i) => {
    const at = `${i + 1}번째 줄`;
    const repo = String(r?.repo ?? "");
    const number = Number(r?.number);
    if (!TRIAGE_REPOS.includes(repo)) return errors.push(`${at}: repo는 ${TRIAGE_REPOS.join(", ")} 중 하나여야 해요`);
    if (!Number.isInteger(number) || number <= 0) return errors.push(`${at}: number가 이슈 번호가 아니에요`);
    if (r.week != null && r.week !== "current") return errors.push(`${at}: week는 "current"만 쓸 수 있어요`);
    items.push({
      repo,
      number,
      status: r.status ?? null,
      priority: r.priority ?? null,
      kind: r.kind ?? null,
      week: r.week ?? null,
    });
  });
  return { items, errors };
}

/**
 * 일괄 분류를 적용한다. apply가 false면 바뀔 내용만 돌려준다(아무것도 바꾸지 않음).
 * 사람이 정한 값이라도 입력에 적힌 칸은 입력대로 바꾼다. 입력에 없는 칸은 그대로 둔다.
 */
export async function applyTriage({ graphql, org, projectTitle, items, today, apply = false }) {
  const project = await findProject(graphql, org, projectTitle);
  if (!project) return { lines: [`진행판 "${projectTitle}"을 찾지 못했어요(토큰 권한 또는 이름 확인)`], problems: 1 };
  const lines = [];
  let problems = 0;
  const it = currentIteration(project.week?.configuration?.iterations, today);

  for (const t of items) {
    const label = `${SHORT_REPO[t.repo]} #${t.number}`;
    const issue = await findIssue(graphql, org, t.repo, t.number, project.id);
    if (!issue) {
      lines.push(`${label}: 열린 이슈가 아니라 건너뜀`);
      continue;
    }
    const cur = issue.item ?? { status: null, priority: null, kind: null, iteration: null };
    const changes = [];
    const wrong = [];
    for (const [key, field] of [["status", project.status], ["priority", project.priority], ["kind", project.kind]]) {
      const value = t[key];
      if (value == null) continue;
      const name = FIELD[key];
      const opt = findOption(field, value);
      if (!opt) wrong.push(`${name} "${value}" 선택지가 없음`);
      else if (cur[key] !== opt.name) changes.push({ field, opt, text: `${name} ${cur[key] ?? "(없음)"} → ${opt.name}` });
    }
    let week = null;
    if (t.week === "current") {
      if (!project.week || !it) wrong.push(`${FIELD.week}: 오늘이 들어 있는 주차가 없음`);
      else if (cur.iteration !== it.id) week = it;
    }
    problems += wrong.length;
    const texts = [...(issue.item ? [] : ["진행판에 넣음"]), ...changes.map((c) => c.text), ...(week ? [`${FIELD.week} → ${week.startDate} 주`] : []), ...wrong];
    lines.push(`${label}: ${texts.length ? texts.join(", ") : "바꿀 것 없음"}`);

    if (!apply || (!changes.length && !week && issue.item)) continue;
    const { item } = await ensureItem(graphql, project, issue);
    for (const c of changes) await setSelect(graphql, project, c.field, item.id, c.opt.id);
    if (week) await graphql(SET_ITERATION, { p: project.id, i: item.id, f: project.week.id, o: week.id });
  }
  return { lines, problems };
}

/** 일괄 분류 워크플로의 진입점 */
export async function runTriage({ github, core, org, projectTitle, text, apply, hasToken, today = kstToday() }) {
  const { items, errors } = parseTriage(text);
  if (errors.length) return core.setFailed(["입력을 고쳐 주세요", ...errors].join("\n"));
  if (!items.length) return core.setFailed("분류할 이슈가 없어요");
  if (!hasToken) return core.setFailed("진행판 토큰이 없어요. PROJECT_APP_ID와 PROJECT_APP_PRIVATE_KEY(또는 PROJECT_TOKEN)를 확인해 주세요");
  const { lines, problems } = await applyTriage({ graphql: github.graphql, org, projectTitle, items, today, apply });
  const head = apply ? "적용함" : "시험 실행(바뀌지 않음). 적용하려면 apply를 켜고 다시 실행";
  core.info([head, ...lines].join("\n"));
  await core.summary.addHeading(`진행판 분류: ${head}`, 3).addList(lines).write();
  if (problems) core.setFailed(`선택지나 주차를 찾지 못한 칸이 ${problems}개 있어요(위 목록 참고)`);
}
