/** 利用者に返す HTTP エラー。ハンドラーがこの status と message をそのまま応答にする */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
