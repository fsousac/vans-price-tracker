# ADR-0003: Dinheiro em centavos inteiros

Status: aceito (2026-10-14).

## Contexto

O OCC devolve `value` em ponto flutuante com ruído (`99.99000000000001`, `49.989999999999995`) e `formattedValue` inconsistente ("R$ 279,99" vs "R$99,99"). O requisito exige preço-alvo decimal exato e faixa `T <= P <= T*(1+M)` sem erro de arredondamento. Falso alerta por arredondar é o risco R-08.

## Decisão

1. Todo valor monetário em memória e no banco é `Cents` = inteiro de BRL (`INTEGER`, colunas `*_cents`). Nunca `REAL`, nunca string decimal no domínio.
2. Conversão da loja: `cents = Math.round(value * 100)`; se `Math.abs(value*100 - cents) > 1e-6`, o valor não é decimal de 2 casas e a leitura falha com `preco_invalido` (RN-01). `formattedValue` nunca é parseado.
3. Entrada do usuário (`parseBrlToCents`): aceita `.` ou `,` decimal; milhar com `.` só com decimal `,` (`1.234,50`); até 2 casas, sem arredondar (`379,999` é recusado); `0 < T <= 9.999.999` centavos (R$ 99.999,99).
4. Margem em pontos-base inteiros (`margin_bp`, 300 = 3%), 0-5000.
5. Comparação em inteiros: `ATINGIDO: P <= T`; `PROXIMO: P*10000 <= T*(10000+bp)`; senão `ACIMA`. Máximo do produto: 9.999.999 x 15.000 ≈ 1,5e11, muito abaixo de 2^53 (9,0e15); `Number` é exato, sem `BigInt` (RF-05-AC6 atendido; um teste de extremos garante). `BigInt` entra só se o teto de preço crescer em ordens de grandeza.
6. O banco reforça: `CHECK (current_cents > 0 AND current_cents <= original_cents)`; "preço de falha" R$ 0 é inexpressável.
7. Percentual de desconto é calculado (`round((orig-cur)*100/orig)`), nunca lido (`percentualOfDiscount` é `""` no SSR).
8. Formatação apenas na borda (`formatBrl`, `R$ 1.234,56`).

## Alternativas

| Alternativa | Por que não |
|---|---|
| `REAL`/`number` decimal | Ruído de float; `99.99000000000001 <= 99.99` é falso |
| String decimal + biblioteca (`decimal.js`) | Dependência para 2 casas; inteiros bastam |
| `BigInt` em todo lugar | Sem necessidade na faixa de valores; atrito com SQLite/JSON |
| Arredondar entrada do usuário | Esconde erro (`379,999`); recusar é mais honesto |

## Consequências

Aritmética exata e testável por tabela (as do requirements 5.4); conversões em um único ponto (`shared/money.ts`) com 100% de ramos testados; toda coluna de dinheiro tem sufixo, o que facilita varredura. Custo: não se representam frações de centavo (a loja não usa).
