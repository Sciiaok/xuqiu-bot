'use client';

import { useMemo, useState } from 'react';
import s from './page.module.css';
import e from './LeadFieldsEditor.module.css';

// ── Constants & helpers ────────────────────────────────────────────────

const TYPE_LABELS = {
  text:    '文字',
  number:  '数字',
  boolean: '是 / 否',
  enum:    '选项',
  array:   '多个值（高级）',
};

const BASIC_TYPES = ['text', 'number', 'boolean', 'enum'];
const ADVANCED_TYPES = [...BASIC_TYPES, 'array'];

const IMPORTANCE_OPTIONS = [
  { value: '',        dot: '⚪️', label: '可选',     desc: '有最好' },
  { value: 'GOOD',    dot: '🔵', label: '基础信息', desc: '没有就不算合格 lead' },
  { value: 'QUALIFY', dot: '🟢', label: '决定资质', desc: '影响 lead 评级' },
  { value: 'PROOF',   dot: '🟡', label: '需要证据', desc: '客户需提供材料' },
];

const KEY_REGEX = /^[a-z][a-z0-9_]*$/;

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f_$1')
    .slice(0, 60);
}

function reorder(arr) {
  return arr.map((row, i) => ({ ...row, display_order: (i + 1) * 10 }));
}

function validateRow(row, allRows, idx) {
  const errs = {};
  if (!row.key?.trim()) errs.key = '字段 ID 必填（自动从名称生成；中文请手填英文 ID）';
  else if (!KEY_REGEX.test(row.key)) errs.key = '字段 ID 仅支持小写字母/数字/下划线，且以字母开头';
  else if (allRows.some((r, i) => i !== idx && r.key === row.key)) errs.key = '字段 ID 与其它字段重复';
  if (!row.label?.trim()) errs.label = '名称必填';
  if (row.type === 'enum' && (!Array.isArray(row.enum_values) || row.enum_values.length === 0)) {
    errs.enum_values = '至少添加 1 个选项';
  }
  if (row.type === 'array') {
    try {
      const parsed = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
      if (!parsed || typeof parsed !== 'object') errs.items = '必须是 JSON 对象';
    } catch (err) {
      errs.items = `JSON 不合法：${err.message}`;
    }
  }
  return errs;
}

/** Strip internal __* fields and re-build the canonical shape for save. */
export function normalizeLeadFields(rows) {
  return reorder(Array.isArray(rows) ? rows : []).map((row) => {
    const out = {
      key: (row.key || '').trim(),
      label: (row.label || '').trim(),
      type: row.type || 'text',
      description: row.description || '',
      required_for: row.required_for || null,
      display_order: row.display_order,
    };
    if (row.type === 'enum') out.enum_values = Array.isArray(row.enum_values) ? row.enum_values : [];
    if (row.type === 'array') {
      out.items = typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || { type: 'string' });
    }
    return out;
  });
}

// ── Main component ─────────────────────────────────────────────────────

export default function LeadFieldsEditor({ value, onChange }) {
  const [advanced, setAdvanced] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [sourceText, setSourceText] = useState(() => JSON.stringify(value || [], null, 2));
  const [sourceError, setSourceError] = useState('');
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [showHelp, setShowHelp] = useState(false);

  const rows = Array.isArray(value) ? value : [];
  const errors = useMemo(() => rows.map((row, idx) => validateRow(row, rows, idx)), [rows]);
  const hasErrors = errors.some((errs) => Object.keys(errs).length > 0);

  function emit(nextRows) {
    const ordered = reorder(nextRows);
    const stillValid = ordered.every((row, idx) => Object.keys(validateRow(row, ordered, idx)).length === 0);
    onChange(ordered, stillValid);
  }

  function updateRow(idx, patch) {
    const next = rows.map((r, i) => {
      if (i !== idx) return r;
      const merged = { ...r, ...patch };
      // Auto-sync key from label while autoKey flag is still set.
      if (patch.label !== undefined && r.__autoKey) {
        const candidate = slugify(patch.label);
        if (candidate) merged.key = candidate;
      }
      // User manually edited the key → stop auto-syncing.
      if (patch.key !== undefined) merged.__autoKey = false;
      return merged;
    });
    emit(next);
  }

  function addRow() {
    const newRow = {
      key: '',
      label: '',
      type: 'text',
      description: '',
      required_for: null,
      __autoKey: true,
    };
    emit([...rows, newRow]);
    setExpandedIdx(rows.length);
  }

  function removeRow(idx) {
    if (!window.confirm('删除这个字段？')) return;
    emit(rows.filter((_, i) => i !== idx));
    setExpandedIdx(null);
  }

  function moveRow(idx, delta) {
    const target = idx + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[idx], next[target]] = [next[target], next[idx]];
    emit(next);
    if (expandedIdx === idx) setExpandedIdx(target);
    else if (expandedIdx === target) setExpandedIdx(idx);
  }

  function openSource() {
    setSourceText(JSON.stringify(normalizeLeadFields(rows), null, 2));
    setSourceError('');
    setSourceMode(true);
  }

  function closeSource() {
    try {
      const parsed = JSON.parse(sourceText);
      if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
      emit(parsed);
      setSourceError('');
      setSourceMode(false);
    } catch (err) {
      setSourceError(err.message);
    }
  }

  function handleSourceChange(text) {
    setSourceText(text);
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('必须是 JSON 数组');
      setSourceError('');
      const ordered = reorder(parsed);
      const stillValid = ordered.every((row, idx) => Object.keys(validateRow(row, ordered, idx)).length === 0);
      onChange(ordered, stillValid);
    } catch (err) {
      setSourceError(err.message);
      onChange(rows, false);
    }
  }

  // ── Source mode UI ──────────────────────────────────────────────
  if (sourceMode) {
    return (
      <div className={e.editor}>
        <div className={e.toolbar}>
          <span className={e.toolbarHint}>源码模式 — 直接编辑 JSON</span>
          <button type="button" className={e.btnGhost} onClick={closeSource}>✕ 退出源码</button>
        </div>
        <textarea
          className={`${s.jsonTextarea} ${sourceError ? s.jsonTextareaError : ''}`}
          value={sourceText}
          onChange={(ev) => handleSourceChange(ev.target.value)}
          spellCheck={false}
        />
        {sourceError && <div className={s.errorBanner}>JSON 不合法：{sourceError}</div>}
      </div>
    );
  }

  // ── Visual mode UI ──────────────────────────────────────────────
  const typeOptions = advanced ? ADVANCED_TYPES : BASIC_TYPES;

  return (
    <div className={e.editor}>
      <div className={e.toolbar}>
        <div className={e.toolbarLeft}>
          <button type="button" className={e.btnPrimary} onClick={addRow}>+ 添加字段</button>
          <button
            type="button"
            className={e.helpToggle}
            onClick={() => setShowHelp((v) => !v)}
          >
            ⓘ "重要程度"是什么意思？{showHelp ? ' ▴' : ' ▾'}
          </button>
        </div>
        <div className={e.toolbarRight}>
          {advanced && (
            <button type="button" className={e.btnGhost} onClick={openSource}>{`{ } 源码`}</button>
          )}
          <label className={e.advancedToggle}>
            <input
              type="checkbox"
              checked={advanced}
              onChange={(ev) => setAdvanced(ev.target.checked)}
            />
            <span>⌃ 高级模式</span>
          </label>
        </div>
      </div>

      {showHelp && (
        <div className={e.helpPanel}>
          <p className={e.helpIntro}>
            AI 会根据已收集到的字段，给每条对话打一个 <strong>lead 等级</strong>（BAD → GOOD → QUALIFY → PROOF）。
            等级越高，AI 越可能把这条线索升级、甚至直接通知销售跟进。
            "重要程度"决定每个字段属于哪一档：
          </p>
          <table className={e.helpTable}>
            <tbody>
              <tr>
                <td className={e.helpTier}>🔵 基础信息</td>
                <td>这些字段都填齐 → 这条对话才算 <strong>GOOD lead</strong>。少一个都不算。<br />
                  <span className={e.helpExample}>典型例子：品牌、产品类型</span>
                </td>
              </tr>
              <tr>
                <td className={e.helpTier}>🟢 决定资质</td>
                <td>在 GOOD 基础上，这些再填齐 → 升级为 <strong>QUALIFY</strong>，AI 会更认真地继续跟。<br />
                  <span className={e.helpExample}>典型例子：采购数量、公司类型、目的国</span>
                </td>
              </tr>
              <tr>
                <td className={e.helpTier}>🟡 需要证据</td>
                <td>在 QUALIFY 基础上，这些也有 → 升级为 <strong>PROOF</strong>，<strong>系统自动通知销售人工接手</strong>。<br />
                  <span className={e.helpExample}>典型例子：营业执照、付款方式确认、采购合同</span>
                </td>
              </tr>
              <tr>
                <td className={e.helpTier}>⚪️ 可选</td>
                <td>知道一下挺好，但不影响等级判定。AI 仍然会尝试问。</td>
              </tr>
            </tbody>
          </table>
          <p className={e.helpFooter}>
            👉 简单粗暴的判断：<strong>"客户填了哪些信息，我才愿意让销售去跟？"</strong>
            把"必须有的"设成 🔵；"决定值不值得跟"的设成 🟢；"必须看到证据才转人工"的设成 🟡。
          </p>
        </div>
      )}

      {rows.length === 0 ? (
        <div className={e.empty}>
          还没有字段。点击"+ 添加字段"开始定义 AI 要从对话里搞清楚的信息。
        </div>
      ) : (
        <div className={e.list}>
          <div className={`${e.row} ${e.headerRow} ${advanced ? e.rowAdvanced : ''}`}>
            <span />
            <span>名称</span>
            {advanced && <span>字段 ID</span>}
            <span>答案类型</span>
            <span>重要程度</span>
            <span />
            <span />
          </div>

          {rows.map((row, idx) => (
            <FieldRow
              key={idx}
              row={row}
              errors={errors[idx]}
              advanced={advanced}
              expanded={expandedIdx === idx}
              isFirst={idx === 0}
              isLast={idx === rows.length - 1}
              typeOptions={typeOptions}
              onToggleExpand={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
              onChange={(patch) => updateRow(idx, patch)}
              onRemove={() => removeRow(idx)}
              onMoveUp={() => moveRow(idx, -1)}
              onMoveDown={() => moveRow(idx, 1)}
            />
          ))}
        </div>
      )}

      {hasErrors && (
        <div className={s.errorBanner}>有字段未通过校验，保存按钮已禁用。</div>
      )}
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────────

function FieldRow({
  row, errors, advanced, expanded, isFirst, isLast, typeOptions,
  onToggleExpand, onChange, onRemove, onMoveUp, onMoveDown,
}) {
  const importance = IMPORTANCE_OPTIONS.find((o) => (o.value || null) === (row.required_for || null))
    || IMPORTANCE_OPTIONS[0];
  const hasErr = Object.keys(errors).length > 0;

  return (
    <>
      <div className={`${e.row} ${e.dataRow} ${advanced ? e.rowAdvanced : ''} ${hasErr ? e.rowInvalid : ''}`}>
        <div className={e.reorder}>
          <button type="button" className={e.iconBtn} onClick={onMoveUp} disabled={isFirst} title="上移">↑</button>
          <button type="button" className={e.iconBtn} onClick={onMoveDown} disabled={isLast} title="下移">↓</button>
        </div>

        <input
          className={`${e.cellInput} ${errors.label ? e.cellInputError : ''}`}
          value={row.label || ''}
          onChange={(ev) => onChange({ label: ev.target.value })}
          placeholder="例如：品牌 / 采购数量"
        />

        {advanced && (
          <input
            className={`${e.cellInput} ${e.mono} ${errors.key ? e.cellInputError : ''}`}
            value={row.key || ''}
            onChange={(ev) => onChange({ key: ev.target.value })}
            placeholder="brand"
          />
        )}

        <select
          className={e.cellSelect}
          value={row.type || 'text'}
          onChange={(ev) => onChange({ type: ev.target.value })}
        >
          {typeOptions.map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t]}</option>
          ))}
        </select>

        <select
          className={e.cellSelect}
          value={row.required_for || ''}
          onChange={(ev) => onChange({ required_for: ev.target.value || null })}
          title={importance.desc}
        >
          {IMPORTANCE_OPTIONS.map((o) => (
            <option key={o.value || 'optional'} value={o.value}>
              {o.dot} {o.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={`${e.iconBtnSm} ${expanded ? e.iconBtnActive : ''}`}
          onClick={onToggleExpand}
          title={expanded ? '收起' : '更多设置'}
        >⋯</button>

        <button
          type="button"
          className={e.deleteBtn}
          onClick={onRemove}
          title="删除字段"
        >✕</button>
      </div>

      {/* Inline enum chips: always visible for enum type */}
      {row.type === 'enum' && (
        <div className={`${e.subRow} ${errors.enum_values ? e.subRowInvalid : ''}`}>
          <span className={e.subRowLabel}>选项：</span>
          <EnumChips
            value={row.enum_values || []}
            onChange={(vals) => onChange({ enum_values: vals })}
          />
        </div>
      )}

      {/* Expanded panel */}
      {expanded && (
        <div className={e.expandPanel}>
          <label className={e.expandField}>
            <span className={e.expandFieldLabel}>提示 AI（怎么解读 / 例子）</span>
            <textarea
              className={s.textarea}
              rows={2}
              value={row.description || ''}
              onChange={(ev) => onChange({ description: ev.target.value })}
              placeholder="例如：Car brand (e.g. BYD, Toyota). Empty string if unknown."
            />
          </label>

          {!advanced && (
            <label className={e.expandField}>
              <span className={e.expandFieldLabel}>
                字段 ID
                <span className={e.expandFieldHint}>
                  AI 输出 JSON 时用的英文键名。中文名称请手填一个英文 ID。
                </span>
              </span>
              <input
                className={`${s.input} ${e.mono} ${errors.key ? e.cellInputError : ''}`}
                value={row.key || ''}
                onChange={(ev) => onChange({ key: ev.target.value })}
                placeholder="brand"
              />
            </label>
          )}

          {row.type === 'array' && (
            <label className={e.expandField}>
              <span className={e.expandFieldLabel}>
                数组项 schema (items) — JSON
                <span className={e.expandFieldHint}>通常是 {`{"type":"object","properties":{...}}`}</span>
              </span>
              <textarea
                className={`${s.jsonTextarea} ${errors.items ? s.jsonTextareaError : ''}`}
                value={typeof row.items === 'string' ? row.items : JSON.stringify(row.items ?? {}, null, 2)}
                onChange={(ev) => onChange({ items: ev.target.value })}
                spellCheck={false}
                style={{ minHeight: 120 }}
              />
            </label>
          )}
        </div>
      )}

      {/* Inline error messages */}
      {hasErr && (
        <div className={e.rowErrors}>
          {Object.entries(errors).map(([field, msg]) => (
            <span key={field} className={e.rowErrorMsg}>· {msg}</span>
          ))}
        </div>
      )}
    </>
  );
}

// ── Enum chips ─────────────────────────────────────────────────────────

function EnumChips({ value, onChange }) {
  const [draft, setDraft] = useState('');

  function commit() {
    const v = draft.trim();
    if (!v) return;
    if (value.includes(v)) { setDraft(''); return; }
    onChange([...value, v]);
    setDraft('');
  }

  return (
    <div className={e.chips}>
      {value.map((v) => (
        <span key={v} className={e.chip}>
          {v}
          <button
            type="button"
            className={e.chipX}
            onClick={() => onChange(value.filter((x) => x !== v))}
            aria-label={`remove ${v}`}
          >×</button>
        </span>
      ))}
      <input
        className={e.chipInput}
        value={draft}
        onChange={(ev) => setDraft(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ',') {
            ev.preventDefault();
            commit();
          } else if (ev.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder="输入后回车添加"
      />
    </div>
  );
}
