import { fetchAuthSession } from 'aws-amplify/auth';
import type {
  AnswerResponse,
  ApiErrorResponse,
  CatalogResponse,
  DiagramResponse,
  QuestionDetailResponse,
  QuestionListResponse,
  ResetProgressResponse,
  StartDrillRequest,
  StartDrillResponse,
  UpdateDrillRequest,
  UpdateDrillResponse,
} from '../../../shared/types';
import { config } from '../config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function accessToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) throw new ApiError(401, 'ログインの有効期限が切れました。ログインし直してください');
  return token;
}

/**
 * API の呼び先。手元の開発サーバーでは同じオリジンの /api を呼び、vite.config.ts の中継で
 * デプロイ済みの API に届ける（本番の API の CORS は手元のオリジンを許していない）
 */
function apiBase(): string {
  return import.meta.env.DEV ? '/api' : config().apiUrl;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `通信に失敗しました（${res.status}）`;
    try {
      const data = (await res.json()) as Partial<ApiErrorResponse>;
      if (data.message) message = data.message;
    } catch {
      // 本文が JSON でなければ既定のメッセージのまま
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

const examPath = (category: string, exam: string) =>
  `/exams/${encodeURIComponent(category)}/${encodeURIComponent(exam)}`;

export const api = {
  catalog: () => request<CatalogResponse>('GET', '/catalog'),
  questions: (category: string, exam: string) =>
    request<QuestionListResponse>('GET', `${examPath(category, exam)}/questions`),
  question: (category: string, exam: string, id: string) =>
    request<QuestionDetailResponse>(
      'GET',
      `${examPath(category, exam)}/questions/${encodeURIComponent(id)}`,
    ),
  answer: (category: string, exam: string, id: string, selected: number[]) =>
    request<AnswerResponse>(
      'POST',
      `${examPath(category, exam)}/questions/${encodeURIComponent(id)}/answer`,
      { selected },
    ),
  diagram: (category: string, exam: string, id: string, choice: number) =>
    request<DiagramResponse>(
      'GET',
      `${examPath(category, exam)}/questions/${encodeURIComponent(id)}/diagrams/${choice}`,
    ),
  resetProgress: (category: string, exam: string) =>
    request<ResetProgressResponse>('DELETE', `${examPath(category, exam)}/progress`),
  startDrill: (category: string, exam: string, body: StartDrillRequest) =>
    request<StartDrillResponse>('PUT', `${examPath(category, exam)}/drill`, body),
  updateDrill: (category: string, exam: string, body: UpdateDrillRequest) =>
    request<UpdateDrillResponse>('PATCH', `${examPath(category, exam)}/drill`, body),
};
