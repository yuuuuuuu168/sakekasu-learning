import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drill, ExamFile } from '../../shared/types';

const exam: ExamFile = {
  category: 'aws',
  exam: 'dop-c02',
  name: 'DOP',
  code: 'DOP-C02',
  questions: [
    { id: 'Q-1', question: '問1', choices: ['a', 'b', 'c', 'd'], answers: [2], explanations: ['1', '2', '3', '4'] },
    { id: 'Q-2', question: '問2（2 つ選択）', choices: ['a', 'b', 'c', 'd', 'e'], answers: [0, 3], explanations: ['1', '2', '3', '4', '5'], diagramChoices: [0, 2] },
  ],
};

const store = new Map<string, { history: boolean[]; attempts: number; qkey: string }>();
const drills = new Map<string, Drill>();

/** 次の recordAnswer で投げる例外（競合の再現用） */
let recordError: Error | null = null;

const loadExam = vi.fn(async (c: string, e: string) => (c === 'aws' && e === 'dop-c02' ? exam : null));

vi.mock('../lambda/api/questions', () => ({
  loadExam: (c: string, e: string) => loadExam(c, e),
  loadDiagram: async (_c: string, _e: string, id: string, choice: number) => `data:image/png;base64,${id}-${choice}`,
  loadCatalog: async () => ({
    generatedAt: '',
    categories: [
      {
        category: 'aws',
        name: 'AWS',
        order: 1,
        exams: [{ category: 'aws', exam: 'dop-c02', name: 'DOP', order: 1, questionCount: 2 }],
      },
    ],
  }),
}));

vi.mock('../lambda/api/progress', async () => {
  const { masteryOf } = await import('../../shared/mastery');
  const prefix = (c: string, e: string) => `${c}/${e}#`;
  const drillKey = (c: string, e: string) => `drill#${c}/${e}`;
  return {
    examPrefix: prefix,
    drillKey,
    getDrill: async (_u: string, c: string, e: string) => drills.get(drillKey(c, e)),
    putDrill: async (_u: string, c: string, e: string, drill: Drill) => void drills.set(drillKey(c, e), drill),
    updateDrill: async (_u: string, c: string, e: string, id: string, current: string | null) => {
      const drill = drills.get(drillKey(c, e));
      if (!drill || drill.id !== id || (current !== null && !drill.queue.includes(current))) return false;
      if (current === null) drills.delete(drillKey(c, e));
      else drills.set(drillKey(c, e), { ...drill, current });
      return true;
    },
    toProgress: (id: string, item?: { history: boolean[]; attempts: number }) => ({
      id,
      mastery: masteryOf(item?.history ?? []),
      attempts: item?.attempts ?? 0,
      history: item?.history ?? [],
    }),
    getProgress: async (_u: string, c: string, e: string, id: string) => store.get(`${prefix(c, e)}${id}`),
    listAllProgress: async () => [...store.values(), ...[...drills.keys()].map((qkey) => ({ qkey }))],
    listExamProgress: async (_u: string, c: string, e: string) =>
      new Map([...store.values()].map((v) => [v.qkey.slice(prefix(c, e).length), v])),
    recordAnswer: async (_u: string, c: string, e: string, id: string, correct: boolean) => {
      if (recordError) throw recordError;
      const qkey = `${prefix(c, e)}${id}`;
      const prev = store.get(qkey);
      const next = { qkey, history: [...(prev?.history ?? []), correct], attempts: (prev?.attempts ?? 0) + 1 };
      store.set(qkey, next);
      return next;
    },
    resetExamProgress: async () => {
      const n = store.size;
      store.clear();
      return n;
    },
  };
});

const { handler } = await import('../lambda/api/index');
const { HttpError } = await import('../lambda/api/http-error');

function event(routeKey: string, pathParameters: Record<string, string> = {}, body?: unknown, sub = 'user-1') {
  return {
    routeKey,
    pathParameters,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: sub ? { sub } : {}, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

async function call(e: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const res = (await handler(e)) as APIGatewayProxyStructuredResultV2;
  return { status: res.statusCode, body: JSON.parse(res.body as string) };
}

const q = (id: string) => ({ category: 'aws', exam: 'dop-c02', id });

describe('API', () => {
  beforeEach(() => {
    store.clear();
    drills.clear();
  });

  it('sub が無ければ 401', async () => {
    expect((await call(event('GET /catalog', {}, undefined, ''))).status).toBe(401);
  });

  it('問題の取得では正解と解説を返さない', async () => {
    const { status, body } = await call(event('GET /exams/{category}/{exam}/questions/{id}', q('Q-2')));
    expect(status).toBe(200);
    expect(body.selectCount).toBe(2);
    // 画面用の通し番号（管理用の id とは別）
    expect(body.number).toBe(2);
    expect(body.total).toBe(2);
    expect(body).not.toHaveProperty('answers');
    expect(body).not.toHaveProperty('explanations');
    expect(body).not.toHaveProperty('diagram');
  });

  it('採点して履歴を記録し、2回連続正解でバッチリになる', async () => {
    const route = 'POST /exams/{category}/{exam}/questions/{id}/answer';
    const first = await call(event(route, q('Q-2'), { selected: [3, 0] }));
    expect(first.body.correct).toBe(true);
    expect(first.body.answers).toEqual([0, 3]);
    // 図解がある選択肢を返す（図そのものは別の API で取る）
    expect(first.body.diagramChoices).toEqual([0, 2]);
    expect(first.body.progress.mastery).toBe('shaky');

    const second = await call(event(route, q('Q-2'), { selected: [0, 3] }));
    expect(second.body.progress.mastery).toBe('mastered');

    const wrong = await call(event(route, q('Q-1'), { selected: [0] }));
    expect(wrong.body.correct).toBe(false);
    expect(wrong.body.progress.mastery).toBe('weak');
    expect(wrong.body.diagramChoices).toEqual([]);

    const list = await call(event('GET /exams/{category}/{exam}/questions', q('')));
    expect(list.body.mastery).toEqual({ mastered: 1, shaky: 0, weak: 1, unanswered: 0 });
    expect(list.body.questions.map((x: { id: string; number: number }) => [x.id, x.number])).toEqual([
      ['Q-1', 1],
      ['Q-2', 2],
    ]);
  });

  it('不正な回答は 400', async () => {
    const route = 'POST /exams/{category}/{exam}/questions/{id}/answer';
    for (const selected of [[], [9], [0, 0], ['a'], null]) {
      expect((await call(event(route, q('Q-1'), { selected }))).status).toBe(400);
    }
  });

  it('記録の競合は 409、それ以外の失敗は 500', async () => {
    const route = 'POST /exams/{category}/{exam}/questions/{id}/answer';
    try {
      recordError = new HttpError(409, '回答の記録が競合しました。もう一度送ってください');
      expect((await call(event(route, q('Q-1'), { selected: [2] }))).status).toBe(409);
      recordError = new Error('boom');
      expect((await call(event(route, q('Q-1'), { selected: [2] }))).status).toBe(500);
    } finally {
      recordError = null;
    }
  });

  it('不正なパスや存在しない問題を弾く', async () => {
    const route = 'GET /exams/{category}/{exam}/questions/{id}';
    expect((await call(event(route, { category: '../x', exam: 'dop-c02', id: 'Q-1' }))).status).toBe(400);
    expect((await call(event(route, q('Q-9')))).status).toBe(404);
    expect((await call(event(route, { category: 'aws', exam: 'nope', id: 'Q-1' }))).status).toBe(404);
  });

  it('図解は回答したことのある問題の、図がある選択肢だけ返す', async () => {
    const route = 'GET /exams/{category}/{exam}/questions/{id}/diagrams/{choice}';
    const path = (choice: string) => ({ ...q('Q-2'), choice });
    expect((await call(event(route, path('0')))).status).toBe(403);
    await call(event('POST /exams/{category}/{exam}/questions/{id}/answer', q('Q-2'), { selected: [1, 2] }));
    const ok = await call(event(route, path('2')));
    expect(ok.status).toBe(200);
    expect(ok.body.image).toBe('data:image/png;base64,Q-2-2');
    expect((await call(event(route, path('1')))).status).toBe(404);
    expect((await call(event(route, path('x')))).status).toBe(400);
  });

  it('カタログは未回答数を問題数から数える', async () => {
    const { body } = await call(event('GET /catalog'));
    expect(body.categories[0].exams[0].mastery.unanswered).toBe(2);
  });

  it('スケジュールからの温めの呼び出しでは、カタログにある資格の問題をすべて読み込んでおく', async () => {
    loadExam.mockClear();
    await expect(handler({ warmup: true })).resolves.toBeUndefined();
    expect(loadExam).toHaveBeenCalledWith('aws', 'dop-c02');
  });

  describe('演習の続き', () => {
    const route = (method: string) => `${method} /exams/{category}/{exam}/drill`;
    const examPath = q('');

    it('始めた演習を問題一覧とカタログで返し、進めた位置を残す', async () => {
      const started = await call(event(route('PUT'), examPath, { filter: 'review', order: 'sequential', queue: ['Q-2', 'Q-1'] }));
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({ filter: 'review', order: 'sequential', queue: ['Q-2', 'Q-1'], current: 'Q-2' });
      const { id } = started.body as Drill;

      const moved = await call(event(route('PATCH'), examPath, { id, current: 'Q-1' }));
      expect(moved.body).toEqual({ updated: true });
      const list = await call(event('GET /exams/{category}/{exam}/questions', examPath));
      expect(list.body.drill).toMatchObject({ id, current: 'Q-1' });
      const catalog = await call(event('GET /catalog'));
      expect(catalog.body.categories[0].exams[0].drill).toBe(true);

      // 古い演習の ID や並びに無い問題では書き換えない
      expect((await call(event(route('PATCH'), examPath, { id: 'old', current: 'Q-2' }))).body).toEqual({ updated: false });
      expect((await call(event(route('PATCH'), examPath, { id, current: 'Q-9' }))).body).toEqual({ updated: false });

      // 終えたら続きを消す
      expect((await call(event(route('PATCH'), examPath, { id, current: null }))).body).toEqual({ updated: true });
      expect((await call(event('GET /exams/{category}/{exam}/questions', examPath))).body.drill).toBeNull();
      expect((await call(event('GET /catalog'))).body.categories[0].exams[0].drill).toBe(false);
    });

    it('削除された問題は並びから外し、その先の問題から再開させる', async () => {
      drills.set('drill#aws/dop-c02', { id: 'd', filter: 'all', order: 'random', queue: ['Q-1', 'Q-8', 'Q-2'], current: 'Q-8' });
      const list = await call(event('GET /exams/{category}/{exam}/questions', examPath));
      expect(list.body.drill).toMatchObject({ queue: ['Q-1', 'Q-2'], current: 'Q-2' });

      drills.set('drill#aws/dop-c02', { id: 'd', filter: 'all', order: 'random', queue: ['Q-1', 'Q-8', 'Q-9'], current: 'Q-8' });
      expect((await call(event('GET /exams/{category}/{exam}/questions', examPath))).body.drill).toBeNull();
    });

    it('不正な条件や並びは 400', async () => {
      for (const body of [
        { filter: 'nope', order: 'random', queue: ['Q-1'] },
        { filter: 'all', order: 'nope', queue: ['Q-1'] },
        { filter: 'all', order: 'random', queue: [] },
        { filter: 'all', order: 'random', queue: ['Q-9'] },
        { filter: 'all', order: 'random', queue: ['Q-1', 'Q-1'] },
        { filter: 'all', order: 'random', queue: 'Q-1' },
        null,
      ]) {
        expect((await call(event(route('PUT'), examPath, body))).status).toBe(400);
      }
      for (const body of [{ current: 'Q-1' }, { id: 'd', current: 1 }, { id: 'd' }, null]) {
        expect((await call(event(route('PATCH'), examPath, body))).status).toBe(400);
      }
      expect(drills.size).toBe(0);
    });
  });
});
