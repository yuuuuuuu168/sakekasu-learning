import type { CatalogResponse } from '../../../shared/types';

type CatalogCategory = CatalogResponse['categories'][number];
export type CatalogExam = CatalogCategory['exams'][number];

/**
 * 資格一覧を、演習中の資格（分野ごと）とアーカイブした資格に分ける。
 * 資格がすべてアーカイブされた分野は、演習中の側に出さない。アーカイブは新しい順に並べる
 */
export function splitArchived(categories: CatalogCategory[]) {
  const active = categories
    .map((category) => ({ ...category, exams: category.exams.filter((exam) => !exam.archivedAt) }))
    .filter((category) => category.exams.length > 0);
  const archived = categories
    .flatMap((category) => category.exams)
    .filter((exam) => exam.archivedAt)
    .sort((a, b) => b.archivedAt!.localeCompare(a.archivedAt!));
  return { active, archived };
}

/** アーカイブした日（例: 2026/11/23）。日本時間で数える */
export function archivedDate(archivedAt: string): string {
  return new Date(archivedAt).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
}
