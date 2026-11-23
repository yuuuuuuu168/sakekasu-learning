import { describe, expect, it } from 'vitest';
import { archivedDate, splitArchived, type CatalogExam } from './archive';

const mastery = { mastered: 0, shaky: 0, weak: 0, unanswered: 10 };
const exam = (id: string, archivedAt: string | null): CatalogExam => ({
  category: 'aws',
  exam: id,
  name: id,
  order: 1,
  questionCount: 10,
  mastery,
  drill: false,
  archivedAt,
});

describe('splitArchived', () => {
  it('アーカイブした資格を分け、すべてアーカイブされた分野は演習中の側に出さない', () => {
    const { active, archived } = splitArchived([
      { category: 'aws', name: 'AWS', order: 1, exams: [exam('a', null), exam('b', '2026-01-01T00:00:00Z')] },
      { category: 'tf', name: 'Terraform', order: 2, exams: [exam('c', '2026-06-01T00:00:00Z')] },
    ]);
    expect(active.map((c) => [c.category, c.exams.map((e) => e.exam)])).toEqual([['aws', ['a']]]);
    // 新しくアーカイブした順
    expect(archived.map((e) => e.exam)).toEqual(['c', 'b']);
  });
});

describe('archivedDate', () => {
  it('日本時間の日付で出す', () => {
    expect(archivedDate('2026-11-22T15:30:00.000Z')).toBe('2026/11/23');
  });
});
