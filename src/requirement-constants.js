export const REQUIREMENT_STATUSES = {
  NEEDS_PM: 'needs_pm',
  NEEDS_INFO: 'needs_info',
  READY_FOR_DEV: 'ready_for_dev',
  IN_DEV: 'in_dev',
  READY_FOR_TEST: 'ready_for_test',
  IN_TEST: 'in_test',
  READY_FOR_ACCEPTANCE: 'ready_for_acceptance',
  CLOSED: 'closed',
  REJECTED: 'rejected',
};

export const REQUIREMENT_STATUS_LABELS = {
  [REQUIREMENT_STATUSES.NEEDS_PM]: '需要产品确认',
  [REQUIREMENT_STATUSES.NEEDS_INFO]: '需要补充信息',
  [REQUIREMENT_STATUSES.READY_FOR_DEV]: '需要开发',
  [REQUIREMENT_STATUSES.IN_DEV]: '开发中',
  [REQUIREMENT_STATUSES.READY_FOR_TEST]: '需要测试',
  [REQUIREMENT_STATUSES.IN_TEST]: '测试中',
  [REQUIREMENT_STATUSES.READY_FOR_ACCEPTANCE]: '需要验收',
  [REQUIREMENT_STATUSES.CLOSED]: '已关闭',
  [REQUIREMENT_STATUSES.REJECTED]: '已拒绝',
};

export function requirementStatusLabel(status) {
  return REQUIREMENT_STATUS_LABELS[status] || status || '-';
}

export const REQUIREMENT_PRIORITIES = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
};

export const REQUIREMENT_TYPES = {
  INCIDENT: 'incident',
  IMPROVEMENT: 'improvement',
  FEATURE: 'feature',
  DATA_REPORT: 'data_report',
  OTHER: 'other',
};

export const PRD_TEMPLATE_TYPES = {
  LIGHT: 'light',
  STANDARD: 'standard',
};

export const REQUIREMENT_ROLES = {
  SUBMITTER: 'submitter',
  PM: 'pm',
  DEVELOPER: 'developer',
  TESTER: 'tester',
  ACCEPTOR: 'acceptor',
  ADMIN: 'admin',
};

export const REQUIREMENT_ACTIONS = {
  CREATE_FROM_FEISHU: 'create_from_feishu',
  GENERATE_PLAN: 'generate_plan',
  CONFIRM_PLAN: 'confirm_plan',
  UPDATE_PLAN: 'update_plan',
  UPDATE_PRIORITY: 'update_priority',
  UPDATE_OWNERS: 'update_owners',
  UPDATE_SCHEDULE: 'update_schedule',
  REQUEST_INFO: 'request_info',
  START_DEV: 'start_dev',
  SUBMIT_TEST: 'submit_test',
  START_TEST: 'start_test',
  PASS_TEST: 'pass_test',
  REJECT_TEST: 'reject_test',
  ACCEPT_AND_CLOSE: 'accept_and_close',
  REJECT_ACCEPTANCE: 'reject_acceptance',
  BLOCK: 'block',
  EXTEND_DEADLINE: 'extend_deadline',
  REJECT_AS_INVALID: 'reject_as_invalid',
};

export const CURRENT_OWNER_BY_STATUS = {
  [REQUIREMENT_STATUSES.NEEDS_PM]: 'pm_owner_feishu_user_id',
  [REQUIREMENT_STATUSES.NEEDS_INFO]: 'submitter_feishu_user_id',
  [REQUIREMENT_STATUSES.READY_FOR_DEV]: 'developer_feishu_user_id',
  [REQUIREMENT_STATUSES.IN_DEV]: 'developer_feishu_user_id',
  [REQUIREMENT_STATUSES.READY_FOR_TEST]: 'tester_feishu_user_id',
  [REQUIREMENT_STATUSES.IN_TEST]: 'tester_feishu_user_id',
  [REQUIREMENT_STATUSES.READY_FOR_ACCEPTANCE]: 'acceptor_feishu_user_id',
};
