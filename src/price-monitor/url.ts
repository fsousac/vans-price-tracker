// Allowlist de entrada (S1, D-23, D-24): a URL colada NUNCA é buscada; só o `code` sai daqui.
import { err, ok, type Result } from '../shared/result.ts';
import type { ProductCode } from '../shared/types.ts';

export type UrlRejection = { reason: 'url_invalida' | 'produto_nao_encontrado'; message: string };

const HOST = 'www.vans.com.br';
const PATH = /^\/(?:[a-z0-9-]+\/)?p\/([A-Za-z0-9]{8,20})$/;
const VARIANT_PATH = /^\/(?:[a-z0-9-]+\/)?p\/[A-Za-z0-9]{8,20}-\d+$/; // URL de variante (RF-02-AC5)

const INVALID: UrlRejection = {
  reason: 'url_invalida',
  message: 'Link inválido. Cole o endereço de um produto em https://www.vans.com.br/.../p/CÓDIGO.',
};
const NOT_FOUND: UrlRejection = {
  reason: 'produto_nao_encontrado',
  message: 'Produto não encontrado. Use o link da página do produto, sem o tamanho.',
};

export function extractProductCode(input: string): Result<ProductCode, UrlRejection> {
  if (/%2e/i.test(input)) return err(INVALID); // new URL() resolveria "%2e%2e" como ponto-ponto
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return err(INVALID);
  }
  if (url.protocol !== 'https:' || url.hostname !== HOST) return err(INVALID);
  if ((url.port !== '' && url.port !== '443') || url.username || url.password) return err(INVALID);
  const m = PATH.exec(url.pathname); // query e fragmento são descartados aqui
  if (m) return ok(m[1]!);
  return err(VARIANT_PATH.test(url.pathname) ? NOT_FOUND : INVALID);
}
