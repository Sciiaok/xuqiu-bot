---
name: car-catalog
description: |
  长安/起亚车型目录，包含英文翻译、配置详情、哈萨克斯坦/阿塞拜疆热销信息。
  用于 contextInfo 注入，当客户提及车型关键词或区号命中时主动推荐。
---

# Car Catalog Skill

Static car model data for Changan and Kia vehicles sold in Central Asia markets.

## Data Files

- `car-models.md` — Human-readable markdown with model details, English translations, and hot market info
- `data/car-models.json` — Structured JSON consumed by `lib/car-catalog-context.js` at runtime

## Runtime Integration

`lib/car-catalog-context.js` reads `car-models.json` and builds context strings injected into `contextInfo.car_recommendation` when:
1. **Keyword match**: User message contains car series keywords (e.g. "逸动", "eado", "K5")
2. **Region match**: User's `wa_id` phone prefix matches a hot market (e.g. +7 Kazakhstan, +994 Azerbaijan)
