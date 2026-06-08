import { REQUIREMENT_STATUSES } from './requirement-constants.js';

function markdown(content) {
  return {
    tag: 'div',
    text: { tag: 'lark_md', content: String(content || '-') },
  };
}

function actionButton(textLabel, action, requirementId, type = 'default') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: textLabel },
    type,
    value: { action, requirement_id: requirementId },
  };
}

function statusTemplate(status) {
  if (status === REQUIREMENT_STATUSES.NEEDS_INFO) return 'orange';
  if (status === REQUIREMENT_STATUSES.CLOSED) return 'green';
  if (status === REQUIREMENT_STATUSES.REJECTED) return 'red';
  return 'blue';
}

function acceptanceCriteria(prd) {
  const items = Array.isArray(prd?.acceptance_criteria) ? prd.acceptance_criteria : [];
  if (!items.length) return '-';
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

export function buildRequirementDraftCard(requirement) {
  const missing = Array.isArray(requirement.ai_raw_output?.missing_info)
    ? requirement.ai_raw_output.missing_info
    : [];

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `${requirement.req_no} ${requirement.title}` },
      template: statusTemplate(requirement.status),
    },
    elements: [
      markdown(`**状态**：${requirement.status}`),
      markdown(`**优先级**：${requirement.priority}｜${requirement.priority_reason || '-'}`),
      markdown(`**原始描述**：${requirement.raw_description}`),
      markdown(`**AI 方案**：${requirement.prd?.solution || '-'}`),
      markdown(`**验收标准**：\n${acceptanceCriteria(requirement.prd)}`),
      ...(missing.length ? [markdown(`**需补充**：${missing.join('；')}`)] : []),
      {
        tag: 'action',
        actions: [
          actionButton('生成/刷新方案', 'generate_plan', requirement.id),
          actionButton('确认方案', 'confirm_plan', requirement.id, 'primary'),
          actionButton('打回补充', 'request_info', requirement.id),
          actionButton('先不处理', 'reject_as_invalid', requirement.id, 'danger'),
        ],
      },
    ],
  };
}

export function buildSimpleNoticeCard({ title, lines = [], template = 'blue' }) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: lines.map(line => markdown(line)),
  };
}
