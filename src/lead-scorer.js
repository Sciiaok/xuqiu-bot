/**
 * @deprecated This file is deprecated. Scoring logic has moved to Claude prompt.
 * Kept for backward compatibility during migration.
 */

/**
 * Lead Scoring Engine
 * Calculates lead quality scores and determines routing
 */

import scoringRules from './scoring-rules.json' with { type: 'json' };

/**
 * Calculate routing decision based on score and stage
 */
export function determineRoute(score, stage, isStageComplete) {
  const { routing_thresholds } = scoringRules;

  // Can only route to HUMAN_NOW or NURTURE if PROOF stage is complete
  if (stage === 'PROOF' && isStageComplete) {
    if (score >= routing_thresholds.HUMAN_NOW.min_score) {
      return 'HUMAN_NOW';
    }
    if (score >= routing_thresholds.NURTURE.min_score) {
      return 'NURTURE';
    }
    return 'FAQ_END';
  }

  // If score is very low in any stage, can end early
  if (score < routing_thresholds.FAQ_END.max_score && stage !== 'GREET') {
    return 'FAQ_END';
  }

  // Otherwise continue the conversation
  return 'CONTINUE';
}

/**
 * Calculate score based on lead data and risk flags
 */
export function calculateScore(leadData, riskFlags = []) {
  let score = 0;
  const reasons = [];

  // Identity Trust scoring
  score += scoreIdentityTrust(leadData, reasons);

  // Transaction Intent scoring
  score += scoreTransactionIntent(leadData, reasons);

  // Requirement Clarity scoring
  score += scoreRequirementClarity(leadData, reasons);

  // Risk deductions
  score += applyRiskDeductions(riskFlags, reasons);

  // Ensure score stays within 0-100 bounds
  score = Math.max(0, Math.min(100, score));

  return { score, reasons };
}

/**
 * Score identity trust based on company info and contact details
 */
function scoreIdentityTrust(leadData, reasons) {
  const { identity_trust } = scoringRules;
  let points = 0;

  if (leadData.company_name && leadData.company_name.trim() !== '') {
    points += identity_trust.criteria.company_name_provided.points;
    reasons.push(identity_trust.criteria.company_name_provided.description);
  }

  if (leadData.international_commercial_term && leadData.international_commercial_term.trim() !== '') {
    points += identity_trust.criteria.incoterms_provided.points;
    reasons.push(identity_trust.criteria.incoterms_provided.description);
  }

  return points;
}

/**
 * Score transaction intent based on quantity, destination, timeline
 */
function scoreTransactionIntent(leadData, reasons) {
  const { transaction_intent } = scoringRules;
  let points = 0;

  // Quantity scoring
  if (leadData.qty_bucket) {
    if (leadData.qty_bucket === '20+') {
      points += transaction_intent.criteria.quantity_20_plus.points;
      reasons.push(transaction_intent.criteria.quantity_20_plus.description);
    } else if (leadData.qty_bucket === '6-20') {
      points += transaction_intent.criteria.quantity_6_20.points;
      reasons.push(transaction_intent.criteria.quantity_6_20.description);
    } else if (leadData.qty_bucket === '1-5') {
      points += transaction_intent.criteria.quantity_1_5.points;
      reasons.push(transaction_intent.criteria.quantity_1_5.description);
    }
  }

  // Destination scoring
  if (leadData.destination_port && leadData.destination_port.trim() !== '') {
    points += transaction_intent.criteria.clear_destination.points;
    reasons.push(transaction_intent.criteria.clear_destination.description);
  }

  // Timeline scoring
  if (leadData.timeline && leadData.timeline.trim() !== '') {
    const timeline = leadData.timeline.toLowerCase();
    if (timeline.includes('urgent') || timeline.includes('immediate') || timeline.includes('asap')) {
      points += transaction_intent.criteria.timeline_urgent.points;
      reasons.push(transaction_intent.criteria.timeline_urgent.description);
    } else {
      points += transaction_intent.criteria.timeline_mentioned.points;
      reasons.push(transaction_intent.criteria.timeline_mentioned.description);
    }
  }

  // Budget indication
  if (leadData.budget_indication && leadData.budget_indication.trim() !== '') {
    points += transaction_intent.criteria.budget_discussed.points;
    reasons.push(transaction_intent.criteria.budget_discussed.description);
  }

  return points;
}

/**
 * Score requirement clarity based on technical details
 */
function scoreRequirementClarity(leadData, reasons) {
  const { requirement_clarity } = scoringRules;
  let points = 0;

  // This is primarily evaluated by Claude in real-time
  // We can add bonus points for structured data here

  return points;
}

/**
 * Apply risk flag deductions
 */
function applyRiskDeductions(riskFlags, reasons) {
  const { risk_deductions } = scoringRules;
  let deduction = 0;

  for (const flag of riskFlags) {
    if (risk_deductions.flags[flag]) {
      deduction += risk_deductions.flags[flag].deduction;
      reasons.push(`⚠️ ${risk_deductions.flags[flag].description}`);
    }
  }

  return deduction;
}

/**
 * Get scoring breakdown for transparency
 */
export function getScoreBreakdown(leadData, riskFlags = []) {
  const reasons = [];

  const identityScore = scoreIdentityTrust(leadData, []);
  const transactionScore = scoreTransactionIntent(leadData, []);
  const clarityScore = scoreRequirementClarity(leadData, []);
  const riskDeduction = applyRiskDeductions(riskFlags, []);

  return {
    total: identityScore + transactionScore + clarityScore + riskDeduction,
    breakdown: {
      identity_trust: identityScore,
      transaction_intent: transactionScore,
      requirement_clarity: clarityScore,
      risk_deductions: riskDeduction,
    },
    max_possible: 90, // 30 + 40 + 20
  };
}

/**
 * Validate a lead score to ensure it's reasonable
 */
export function validateScore(score) {
  if (typeof score !== 'number' || isNaN(score)) {
    return 0;
  }
  return Math.max(0, Math.min(100, score));
}

export default {
  determineRoute,
  calculateScore,
  getScoreBreakdown,
  validateScore,
};
