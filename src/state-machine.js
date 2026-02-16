/**
 * State Machine for managing conversation stages
 * Stages: GREET → QUALIFY → PROOF
 */

const STAGES = {
  GREET: 'GREET',
  QUALIFY: 'QUALIFY',
  PROOF: 'PROOF',
};

// Global max turns before routing to FAQ_END
const GLOBAL_MAX_TURNS = 30;

const STAGE_CONFIG = {
  GREET: {
    name: 'GREET',
    description: 'Initial contact - gather basic intent',
    required_fields: ['destination_country', 'qty_bucket', 'car_model'],
    optional_fields: ['destination_port'],
    next_stage: 'QUALIFY',
  },
  QUALIFY: {
    name: 'QUALIFY',
    description: 'Deep qualification',
    required_fields: ['company_name', 'buyer_type'],
    optional_fields: ['timeline', 'budget_indication', 'loading_port'],
    next_stage: 'PROOF',
  },
  PROOF: {
    name: 'PROOF',
    description: 'Verify legitimacy and readiness',
    required_fields: ['international_commercial_term'],
    optional_fields: ['contact_method'],
    next_stage: null, // Final stage
  },
};

/**
 * Get stage configuration
 */
export function getStageConfig(stage) {
  return STAGE_CONFIG[stage] || STAGE_CONFIG.GREET;
}

/**
 * Check if required fields for a stage are complete
 */
export function isStageComplete(stage, leadData) {
  const config = STAGE_CONFIG[stage];
  if (!config) return false;

  return config.required_fields.every(field => {
    const value = leadData[field];
    return value && value.trim() !== '';
  });
}

/**
 * Check if stage should advance
 * Only advances when required fields are complete (no forced advancement)
 * Returns: { shouldAdvance: boolean, reason: string, nextStage: string|null }
 */
export function shouldAdvanceStage(session) {
  const currentStage = session.stage || 'GREET';
  const config = STAGE_CONFIG[currentStage];

  if (!config) {
    return { shouldAdvance: false, reason: 'Invalid stage', nextStage: null };
  }

  // Check if required fields are complete
  const isComplete = isStageComplete(currentStage, session.lead_data);

  // Only advance if required fields are complete
  if (isComplete) {
    return {
      shouldAdvance: true,
      reason: 'Required fields complete',
      nextStage: config.next_stage,
    };
  }

  return {
    shouldAdvance: false,
    reason: 'Continue current stage - still collecting required fields',
    nextStage: null,
  };
}

/**
 * Check if global max turns has been reached
 * Returns true if conversation should be routed to FAQ_END
 */
export function hasReachedGlobalMaxTurns(session) {
  const totalTurns = Math.floor((session.messages?.length || 0) / 2); // Each turn = user + assistant
  return totalTurns >= GLOBAL_MAX_TURNS;
}

/**
 * Get global max turns constant
 */
export function getGlobalMaxTurns() {
  return GLOBAL_MAX_TURNS;
}


/**
 * Get missing required fields for current stage
 */
export function getMissingFields(stage, leadData) {
  const config = STAGE_CONFIG[stage];
  if (!config) return [];

  return config.required_fields.filter(field => {
    const value = leadData[field];
    return !value || value.trim() === '';
  });
}

/**
 * Get completion percentage for current stage
 */
export function getStageProgress(stage, leadData) {
  const config = STAGE_CONFIG[stage];
  if (!config || config.required_fields.length === 0) return 100;

  const completed = config.required_fields.filter(field => {
    const value = leadData[field];
    return value && value.trim() !== '';
  }).length;

  return Math.round((completed / config.required_fields.length) * 100);
}

/**
 * Determine if conversation is complete (all stages done)
 */
export function isConversationComplete(session) {
  return session.stage === 'PROOF' && isStageComplete('PROOF', session.lead_data);
}

/**
 * Get guidance for Claude based on current stage
 */
export function getStageGuidance(stage, leadData) {
  const config = STAGE_CONFIG[stage];
  const missing = getMissingFields(stage, leadData);
  const progress = getStageProgress(stage, leadData);

  return {
    stage: stage,
    description: config.description,
    required_fields: config.required_fields,
    missing_fields: missing,
    progress: progress,
    guidance: generateGuidanceText(stage, missing, progress),
  };
}

/**
 * Generate helpful guidance text for Claude
 */
function generateGuidanceText(stage, missingFields, progress) {
  const config = STAGE_CONFIG[stage];

  if (missingFields.length === 0) {
    return `Stage ${stage} complete (${progress}%). Ready to advance to ${config.next_stage || 'completion'}.`;
  }

  const fieldsList = missingFields.join(', ');
  return `Stage ${stage} at ${progress}%. Still need: ${fieldsList}. Ask naturally about these in your next question.`;
}

export default {
  STAGES,
  STAGE_CONFIG,
  GLOBAL_MAX_TURNS,
  getStageConfig,
  isStageComplete,
  shouldAdvanceStage,
  hasReachedGlobalMaxTurns,
  getGlobalMaxTurns,
  getMissingFields,
  getStageProgress,
  isConversationComplete,
  getStageGuidance,
};
