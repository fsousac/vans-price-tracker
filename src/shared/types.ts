export type Cents = number; // inteiro >= 0 (Number.isSafeInteger); ADR-0003
export type BasisPoints = number; // inteiro 0..5000
export type IsoUtc = string; // '2026-10-14T12:00:00.000Z'
export type ProductCode = string; // '1003800580026U' (validado: [A-Za-z0-9]{8,20})
export type VariantCode = string; // '1003800580026U-34'
export type SourceName = 'occ' | 'next_data' | 'json_ld';

export type FailureClass =
  | 'rede_timeout'
  | 'http_5xx'
  | 'http_429'
  | 'http_403_ou_desafio'
  | 'produto_removido'
  | 'formato_desconhecido'
  | 'preco_invalido'
  | 'host_nao_autorizado';
