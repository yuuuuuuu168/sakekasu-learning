import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExamFile } from '../../shared/types';

const exam: ExamFile = {
  category: 'aws',
  exam: 'dop-c02',
  name: 'DOP',
  code: 'DOP-C02',
  questions: [
    { id: 'Q-1', question: '問1', choices: ['a', 'b', 'c', 'd'], answers: [2], explanations: ['1', '2', '3', '4'] },
    { id: 'Q-2', question: '問2（2 つ選択）', choices: ['a', 'b', 'c', 'd', 'e'], answers: [0, 3], explanations: ['1', '2', '3', '4', '5'], hasDiagram: true },
  ],
};

const store = new Map<string, { history: boolean[]; attempts: number; qkey: string }>();

vi.mock('../lambda/api/questions', () => ({
  loadExam: async (c: string, e: string) => (c === 'aws' && e === 'dop-c02' ? exam : null),
  loadDiagram: async (_c: string, _e: string, id: string) => `data:image/png;base64,${id}`,
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
  return {
    examPrefix: prefix,
    toProgress: (id: string, item?: { history: boolean[]; attempts: number }) => ({
      id,
      mastery: masteryOf(item?.history ?? []),
      attempts: item?.attempts ?? 0,
      history: item?.history ?? [],
    }),
    getProgress: async (_u: string, c: string, e: string, id: string) => store.get(`${prefix(c, e)}${id}`),
    listAllProgress: async () => [...store.values()],
    listExamProgress: async (_u: string, c: string, e: string) =>
      new Map([...store.values()].map((v) => [v.qkey.slice(prefix(c, e).length), v])),
    recordAnswer: async (_u: string, c: string, e: string, id: string, correct: boolean) => {
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
  beforeEach(() => store.clear());

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
    // 図解は回答後にだけ返す。図解の無い問題では返さない
    expect(first.body.diagram).toBe('data:image/png;base64,Q-2');
    expect(first.body.progress.mastery).toBe('shaky');

    const second = await call(event(route, q('Q-2'), { selected: [0, 3] }));
    expect(second.body.progress.mastery).toBe('mastered');

    const wrong = await call(event(route, q('Q-1'), { selected: [0] }));
    expect(wrong.body.correct).toBe(false);
    expect(wrong.body.progress.mastery).toBe('weak');
    expect(wrong.body).not.toHaveProperty('diagram');

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

  it('不正なパスや存在しない問題を弾く', async () => {
    const route = 'GET /exams/{category}/{exam}/questions/{id}';
    expect((await call(event(route, { category: '../x', exam: 'dop-c02', id: 'Q-1' }))).status).toBe(400);
    expect((await call(event(route, q('Q-9')))).status).toBe(404);
    expect((await call(event(route, { category: 'aws', exam: 'nope', id: 'Q-1' }))).status).toBe(404);
  });

  it('カタログは未回答数を問題数から数える', async () => {
    const { body } = await call(event('GET /catalog'));
    expect(body.categories[0].exams[0].mastery.unanswered).toBe(2);
  });
});
