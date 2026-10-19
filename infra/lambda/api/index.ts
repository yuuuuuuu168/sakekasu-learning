/**
 * 学習 API（API Gateway HTTP API + Cognito JWT オーソライザー）。
 *
 * GET    /catalog                                        資格一覧と習熟度の集計
 * GET    /exams/{category}/{exam}/questions              問題一覧（本文なし）と習熟度
 * GET    /exams/{category}/{exam}/questions/{id}         問題本文（正解・解説なし）
 * POST   /exams/{category}/{exam}/questions/{id}/answer  採点して記録し、正解と解説を返す
 * GET    /exams/{category}/{exam}/questions/{id}/diagrams/{choice}  選択肢の図解（回答済みの問題だけ）
 * DELETE /exams/{category}/{exam}/progress               資格1つ分の履歴を消す
 *
 * API とは別に、EventBridge のスケジュールから { warmup: true } で数分おきに呼ばれる。
 * 1 問を考えている間に実行環境が回収され、「回答する」がコールドスタートと問題 JSON の
 * 読み込みを待たされるのを防ぐため。
 *
 * 正解と解説は回答を送るまで返さない。採点もサーバーで行い、記録の正しさを
 * クライアントの自己申告に頼らない。
 */
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { emptyMasteryCounts, isCorrect, masteryOf } from '../../../shared/mastery';
import type {
  AnswerRequest,
  AnswerResponse,
  CatalogResponse,
  DiagramResponse,
  QuestionDetailResponse,
  QuestionListResponse,
} from '../../../shared/types';
import {
  examPrefix,
  getProgress,
  listAllProgress,
  listExamProgress,
  recordAnswer,
  resetExamProgress,
  toProgress,
} from './progress';
import { loadCatalog, loadDiagram, loadExam } from './questions';

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

/** EventBridge のスケジュールから届く、実行環境を温めておくための呼び出し */
interface WarmupEvent {
  warmup: true;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function json(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function pathParam(event: Event, name: string, pattern: RegExp): string {
  const value = event.pathParameters?.[name];
  if (!value || !pattern.test(value)) throw new HttpError(400, `${name} が不正です`);
  return value;
}

async function requireExam(event: Event) {
  const category = pathParam(event, 'category', SLUG);
  const exam = pathParam(event, 'exam', SLUG);
  const file = await loadExam(category, exam);
  if (!file) throw new HttpError(404, '資格が見つかりません');
  return { category, exam, file };
}

async function requireQuestion(event: Event) {
  const ctx = await requireExam(event);
  const id = pathParam(event, 'id', QUESTION_ID);
  const index = ctx.file.questions.findIndex((q) => q.id === id);
  if (index < 0) throw new HttpError(404, '問題が見つかりません');
  return { ...ctx, id, question: ctx.file.questions[index], number: index + 1 };
}

async function getCatalog(userId: string): Promise<CatalogResponse> {
  const [catalog, items] = await Promise.all([loadCatalog(), listAllProgress(userId)]);
  return {
    categories: catalog.categories.map(({ exams, ...category }) => ({
      ...category,
      exams: exams.map((exam) => {
        const prefix = examPrefix(exam.category, exam.exam);
        const mastery = emptyMasteryCounts();
        for (const item of items) {
          if (item.qkey.startsWith(prefix)) mastery[masteryOf(item.history)]++;
        }
        // 問題を削除した後も履歴は残るため、未回答数が負にならないよう丸める
        const answered = mastery.mastered + mastery.shaky + mastery.weak;
        mastery.unanswered = Math.max(0, exam.questionCount - answered);
        return { ...exam, mastery };
      }),
    })),
  };
}

async function getQuestionList(event: Event, userId: string): Promise<QuestionListResponse> {
  const { category, exam, file } = await requireExam(event);
  const [catalog, progressMap] = await Promise.all([
    loadCatalog(),
    listExamProgress(userId, category, exam),
  ]);
  const summary = catalog.categories
    .find((c) => c.category === category)
    ?.exams.find((e) => e.exam === exam) ?? {
    category,
    exam,
    name: file.name,
    code: file.code,
    order: 100,
    questionCount: file.questions.length,
  };

  const mastery = emptyMasteryCounts();
  const questions = file.questions.map((q, i) => {
    const progress = toProgress(q.id, progressMap.get(q.id));
    mastery[progress.mastery]++;
    return { ...progress, number: i + 1 };
  });
  return { exam: summary, mastery, questions };
}

async function getQuestion(event: Event, userId: string): Promise<QuestionDetailResponse> {
  const { category, exam, file, id, question, number } = await requireQuestion(event);
  const item = await getProgress(userId, category, exam, id);
  return {
    id,
    number,
    total: file.questions.length,
    question: question.question,
    choices: question.choices,
    selectCount: question.answers.length,
    progress: toProgress(id, item),
  };
}

function parseAnswer(body: string | undefined, choiceCount: number): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    throw new HttpError(400, 'リクエストの形式が不正です');
  }
  const selected = (parsed as Partial<AnswerRequest>)?.selected;
  if (
    !Array.isArray(selected) ||
    selected.length === 0 ||
    selected.length > choiceCount ||
    !selected.every((v) => Number.isInteger(v) && v >= 0 && v < choiceCount) ||
    new Set(selected).size !== selected.length
  ) {
    throw new HttpError(400, '選択肢の指定が不正です');
  }
  return selected as number[];
}

async function postAnswer(event: Event, userId: string): Promise<AnswerResponse> {
  const { category, exam, id, question } = await requireQuestion(event);
  const body = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  const selected = parseAnswer(body, question.choices.length);
  const correct = isCorrect(selected, question.answers);
  const item = await recordAnswer(userId, category, exam, id, correct, selected);
  return {
    correct,
    answers: question.answers,
    explanations: question.explanations,
    diagramChoices: question.diagramChoices ?? [],
    progress: toProgress(id, item),
  };
}

async function getDiagram(event: Event, userId: string): Promise<DiagramResponse> {
  const { category, exam, id, question } = await requireQuestion(event);
  const choice = Number(pathParam(event, 'choice', /^\d{1,2}$/));
  if (!question.diagramChoices?.includes(choice)) throw new HttpError(404, '図解がありません');
  // 図解は正解を含むため、回答したことのある問題だけに返す
  const item = await getProgress(userId, category, exam, id);
  if (!item || item.attempts === 0) throw new HttpError(403, '回答すると図解を表示できます');
  const image = await loadDiagram(category, exam, id, choice);
  if (!image) throw new HttpError(404, '図解がありません');
  return { image };
}

/** 問題 JSON をすべてキャッシュに載せておく（最初の回答で S3 からの読み込みを待たせない） */
async function warmUp(): Promise<void> {
  const started = Date.now();
  try {
    const catalog = await loadCatalog();
    await Promise.all(
      catalog.categories.flatMap((c) => c.exams.map((e) => loadExam(e.category, e.exam))),
    );
  } catch (err) {
    // 温め損ねても次の回で取り直せる。投げると Errors のアラームが鳴るので、ログに残すだけにする
    console.error('問題データの事前読み込みに失敗しました', err);
  }
  console.log(JSON.stringify({ route: 'warmup', ms: Date.now() - started }));
}

export async function handler(event: Event | WarmupEvent): Promise<APIGatewayProxyResultV2 | void> {
  if ('warmup' in event) return warmUp();
  const started = Date.now();
  const res = await route(event);
  // どの API が遅いかをログで追えるように、経路ごとの処理時間を残す
  const status = typeof res === 'object' ? res.statusCode : undefined;
  console.log(JSON.stringify({ route: event.routeKey, status, ms: Date.now() - started }));
  return res;
}

async function route(event: Event): Promise<APIGatewayProxyResultV2> {
  const userId = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof userId !== 'string' || !userId) return json(401, { message: 'unauthorized' });

  try {
    switch (event.routeKey) {
      case 'GET /catalog':
        return json(200, await getCatalog(userId));
      case 'GET /exams/{category}/{exam}/questions':
        return json(200, await getQuestionList(event, userId));
      case 'GET /exams/{category}/{exam}/questions/{id}':
        return json(200, await getQuestion(event, userId));
      case 'POST /exams/{category}/{exam}/questions/{id}/answer':
        return json(200, await postAnswer(event, userId));
      case 'GET /exams/{category}/{exam}/questions/{id}/diagrams/{choice}':
        return json(200, await getDiagram(event, userId));
      case 'DELETE /exams/{category}/{exam}/progress': {
        const { category, exam } = await requireExam(event);
        return json(200, { deleted: await resetExamProgress(userId, category, exam) });
      }
      default:
        return json(404, { message: 'not found' });
    }
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { message: err.message });
    console.error(err);
    return json(500, { message: 'internal error' });
  }
}
