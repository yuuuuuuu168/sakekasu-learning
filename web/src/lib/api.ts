import { fetchAuthSession } from 'aws-amplify/auth';
import type {
  AnswerResponse,
  CatalogResponse,
  QuestionDetailResponse,
  QuestionListResponse,
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config().apiUrl}${path}`, {
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
      const data = (await res.json()) as { message?: string };
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
  resetProgress: (category: string, exam: string) =>
    request<{ deleted: number }>('DELETE', `${examPath(category, exam)}/progress`),
};
