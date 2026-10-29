import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers/db.ts';
import { SqliteCatalogRepo } from '../../src/catalog/catalog.repo.ts';
import type { CatalogItem } from '../../src/catalog/ports.ts';

const NOW = '2026-10-14T12:00:00.000Z';
const item = (code: string, name: string, slug: string | null = null): CatalogItem => ({
  code,
  name,
  lastSlug: slug,
  priceCents: 49999,
});
const SEED = [
  item('1000000000001U', 'Old Skool Era Navy', 'old-skool-era-navy'),
  item('1000000000002U', 'Tênis ERA 59'),
  item('1000000000003U', 'Authentic Preto'),
  item('1000000000004U', 'Sk8-Hi Camuflado'),
];

test('T-CAT-01 busca "era" acha só nomes com "era", sem acento/caixa', () => {
  const repo = new SqliteCatalogRepo(makeDb());
  repo.replaceAll(SEED, NOW);
  assert.deepEqual(repo.search('era', 10).map((i) => i.code), ['1000000000001U', '1000000000002U']);
  assert.deepEqual(repo.search('TÊNIS', 10).map((i) => i.code), ['1000000000002U']);
  assert.deepEqual(repo.search('camufl', 10).map((i) => i.code), ['1000000000004U']);
  assert.equal(repo.search('zzz', 10).length, 0);
});

test('T-CAT-01 busca trata % e _ como texto e respeita limit', () => {
  const repo = new SqliteCatalogRepo(makeDb());
  repo.replaceAll(SEED, NOW);
  assert.equal(repo.search('%', 10).length, 0);
  assert.equal(repo.search('_', 10).length, 0);
  assert.equal(repo.search('', 3).length, 3);
});

test('T-CAT-06 resultado traz code e slug para abrir por code', () => {
  const repo = new SqliteCatalogRepo(makeDb());
  repo.replaceAll(SEED, NOW);
  const [r] = repo.search('navy', 5);
  assert.equal(r!.code, '1000000000001U');
  assert.equal(r!.lastSlug, 'old-skool-era-navy');
});

test('RF-01-AC5 replaceAll substitui tudo; falha no meio faz rollback e mantém o anterior', () => {
  const repo = new SqliteCatalogRepo(makeDb());
  repo.replaceAll(SEED, NOW);
  repo.replaceAll([item('2000000000001U', 'Novo')], NOW);
  assert.equal(repo.count(), 1);
  assert.throws(() => repo.replaceAll([item('2000000000002U', 'Ok'), item('x', 'code inválido')], NOW));
  assert.equal(repo.count(), 1);
  assert.equal(repo.search('novo', 5).length, 1);
});
