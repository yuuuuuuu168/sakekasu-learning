import type { Mastery } from '../../../shared/mastery';

export const MASTERY_UI: Record<Mastery, { label: string; description: string; dot: string; bar: string; chip: string }> = {
  mastered: {
    label: 'バッチリ',
    description: '直近2回連続で正解',
    dot: 'bg-emerald-500',
    bar: 'bg-emerald-500',
    chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  },
  shaky: {
    label: 'あいまい',
    description: '直近2回で正解と不正解が混在、または1回だけ正解',
    dot: 'bg-amber-400',
    bar: 'bg-amber-400',
    chip: 'bg-amber-50 text-amber-700 ring-amber-200',
  },
  weak: {
    label: '苦手',
    description: '直近2回連続で不正解、または1回だけ回答して不正解',
    dot: 'bg-rose-500',
    bar: 'bg-rose-500',
    chip: 'bg-rose-50 text-rose-700 ring-rose-200',
  },
  unanswered: {
    label: '未回答',
    description: 'まだ回答していない',
    dot: 'bg-slate-300',
    bar: 'bg-slate-200',
    chip: 'bg-slate-50 text-slate-600 ring-slate-200',
  },
};
