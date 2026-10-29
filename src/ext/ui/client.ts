import { errResponse, parseResponse, type Request, type Response } from '../messages.ts';

/** UI -> service worker. Nunca lança: falha de transporte ou resposta malformada vira erro pt-BR. */
export async function send<T = unknown>(req: Request): Promise<Response<T>> {
  try {
    return parseResponse(await chrome.runtime.sendMessage(req)) as Response<T>;
  } catch {
    return errResponse('interno', 'Não foi possível falar com a extensão. Recarregue a página.');
  }
}
