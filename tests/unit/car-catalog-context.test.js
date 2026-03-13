import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildCarCatalogContext } from '../../lib/car-catalog-context.js';

describe('buildCarCatalogContext', () => {
  describe('keyword matching', () => {
    it('should match 逸动 keyword and return Eado configs', () => {
      const result = buildCarCatalogContext('我想看逸动', '8613800000000');
      assert.ok(result.includes('CAR CATALOG MATCH'));
      assert.ok(result.includes('Eado'));
      assert.ok(result.includes('IMPORTANT'));
    });

    it('should match CS55 keyword', () => {
      const result = buildCarCatalogContext('CS55怎么样', '8613800000000');
      assert.ok(result.includes('CAR CATALOG MATCH'));
      assert.ok(result.includes('CS55 PLUS'));
    });

    it('should match 深蓝 G318 keyword', () => {
      const result = buildCarCatalogContext('深蓝G318有货吗', '8613800000000');
      assert.ok(result.includes('Deepal G318'));
      assert.ok(result.includes('EREV'));
    });

    it('should match Kia K5 keyword', () => {
      const result = buildCarCatalogContext('I want a K5', '8613800000000');
      assert.ok(result.includes('Kia K5'));
    });

    it('should match Kia Sportage keyword (Chinese name)', () => {
      const result = buildCarCatalogContext('狮铂拓界多少钱', '8613800000000');
      assert.ok(result.includes('Sportage'));
    });

    it('should match case-insensitively', () => {
      const result = buildCarCatalogContext('I need an eado', '8613800000000');
      assert.ok(result.includes('Eado'));
    });

    it('should match multiple models when keywords overlap', () => {
      const result = buildCarCatalogContext('逸动和CS55都看看', '8613800000000');
      assert.ok(result.includes('Eado'));
      assert.ok(result.includes('CS55'));
    });

    it('should match all Changan models by brand keyword "changan"', () => {
      const result = buildCarCatalogContext('Do you have Changan models?', '8613800000000');
      assert.ok(result.includes('CAR CATALOG MATCH'));
      assert.ok(result.includes('Eado'));
      assert.ok(result.includes('Deepal G318'));
      assert.ok(result.includes('CS55 PLUS'));
    });

    it('should match all Changan models by brand keyword "长安"', () => {
      const result = buildCarCatalogContext('长安有什么车', '8613800000000');
      assert.ok(result.includes('Eado'));
      assert.ok(result.includes('Deepal G318'));
      assert.ok(result.includes('CS55 PLUS'));
    });

    it('should match all Kia models by brand keyword "kia"', () => {
      const result = buildCarCatalogContext('Do you have Kia?', '8613800000000');
      assert.ok(result.includes('K5'));
      assert.ok(result.includes('Sportage'));
      assert.ok(result.includes('K3'));
    });
  });

  describe('region matching', () => {
    it('should detect Kazakhstan from wa_id prefix 77', () => {
      const result = buildCarCatalogContext('hello', '77001234567');
      assert.ok(result.includes('REGION RECOMMENDATION'));
      assert.ok(result.includes('Kazakhstan'));
      assert.ok(result.includes('哈萨克斯坦'));
    });

    it('should detect Azerbaijan from wa_id prefix 994', () => {
      const result = buildCarCatalogContext('hello', '994501234567');
      assert.ok(result.includes('REGION RECOMMENDATION'));
      assert.ok(result.includes('Azerbaijan'));
      assert.ok(result.includes('阿塞拜疆'));
    });

    it('should list hot-selling models for the region', () => {
      const result = buildCarCatalogContext('hello', '77001234567');
      assert.ok(result.includes('Eado'));
      assert.ok(result.includes('CS55'));
      assert.ok(result.includes('K5'));
    });
  });

  describe('no match', () => {
    it('should return empty string when no keyword or region matches', () => {
      const result = buildCarCatalogContext('hello', '8613800000000');
      assert.equal(result, '');
    });

    it('should handle empty message', () => {
      const result = buildCarCatalogContext('', '8613800000000');
      assert.equal(result, '');
    });

    it('should handle null waId', () => {
      const result = buildCarCatalogContext('hello', null);
      assert.equal(result, '');
    });
  });

  describe('combined keyword + region match', () => {
    it('should return both keyword match and region recommendation', () => {
      const result = buildCarCatalogContext('我想看逸动', '77001234567');
      assert.ok(result.includes('CAR CATALOG MATCH'));
      assert.ok(result.includes('REGION RECOMMENDATION'));
      assert.ok(result.includes('Eado'));
      assert.ok(result.includes('Kazakhstan'));
    });
  });
});
