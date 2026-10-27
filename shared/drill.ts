/**
 * 演習（「演習を始める」から始めた問題の並び）の条件。
 * サーバーは受け取った値をここで確かめ、画面はここにある値だけを選ばせる。
 */

export const DRILL_FILTERS = ['all', 'unanswered', 'review', 'weak', 'shaky'] as const;
export type DrillFilter = (typeof DRILL_FILTERS)[number];

export const DRILL_ORDERS = ['random', 'sequential'] as const;
export type DrillOrder = (typeof DRILL_ORDERS)[number];
