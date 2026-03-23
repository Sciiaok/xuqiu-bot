import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import {
  getBrief,
  updateBriefFields,
  updateCompletion,
  updateBrief,
  addMessage,
  addMessages,
  getMessagesForClaude,
  getNextMessageIndex,
} from '../lib/repositories/campaign-brief.repository.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL && { baseURL: config.anthropic.baseURL }),
});

const REQUIRED_FIELDS = [
  'company_name',
  'industry',
  'products',
  'target_countries',
  'target_audience',
  'budget_total',
  'budget_currency',
  'campaign_duration_days',
  'objectives',
  'preferred_platforms',
];

// ── Tool Definitions ────────────────────────────────────────────────────

export function getIntakeTools() {
  return [
    {
      name: 'update_brief',
      description:
        "Update the campaign brief with newly extracted fields from the conversation. Call this whenever you learn new information about the client's requirements. Returns current completion status.",
      input_schema: {
        type: 'object',
        properties: {
          fields: {
            type: 'object',
            description:
              'Partial CampaignBrief fields to merge into the existing brief',
          },
        },
        required: ['fields'],
      },
    },
    {
      name: 'save_brief',
      description:
        'Save the final completed brief and mark the session as complete. Only call this when all required fields are filled and the client has confirmed the brief.',
      input_schema: {
        type: 'object',
        properties: {
          brief: {
            type: 'object',
            description: 'The complete CampaignBrief to save',
          },
        },
        required: ['brief'],
      },
    },
    {
      name: 'parse_attachment',
      description:
        'Parse an uploaded attachment (PDF, image) to extract product information. (Phase 2)',
      input_schema: {
        type: 'object',
        properties: {
          attachment_url: { type: 'string' },
          type: { type: 'string', enum: ['pdf', 'image', 'video'] },
        },
        required: ['attachment_url', 'type'],
      },
    },
  ];
}

// ── System Prompt ───────────────────────────────────────────────────────

export function buildIntakeSystemPrompt() {
  return `你是一位专业的投放需求顾问（Campaign Requirements Consultant），帮助客户定义数字广告投放需求。

═══ 你的职责 ═══
通过自然的多轮对话，收集客户的广告投放需求，形成完整的 Campaign Brief。

═══ CampaignBrief 字段说明 ═══
- company_name: 公司名称
- industry: 所属行业
- products: 推广的产品或服务
- target_countries: 目标投放国家/地区
- target_audience: 目标受众描述
- budget_total: 总预算金额
- budget_currency: 预算货币（如 USD、CNY）
- campaign_duration_days: 投放周期（天数）
- objectives: 投放目标（如品牌曝光、获取线索、促进转化）
- preferred_platforms: 偏好投放平台（如 Google Ads、Meta、TikTok）

═══ 对话策略 ═══
1. 使用清单驱动的多轮对话，不要机械式逐个提问
2. 每次获取到新信息时，立即调用 update_brief 保存
3. 根据上下文主动推荐缺失字段的值（如根据行业推荐合适的投放平台）
4. 推荐值需要客户确认后才算收集完成
5. 所有必填字段收集完毕且客户确认后，调用 save_brief 完成

═══ 回复要求 ═══
- 每条回复控制在300字以内
- 语气专业但友好
- 可以同时询问多个相关字段，避免一问一答
- 用中文回复`;
}

// ── SSE Filtering ───────────────────────────────────────────────────────

function shouldEmit(eventType, streamLevel) {
  if (streamLevel === 'full') return true;
  if (streamLevel === 'events') return eventType !== 'thinking';
  // streamLevel === 'text'
  return (
    eventType === 'delta' ||
    eventType === 'done' ||
    eventType === 'error' ||
    eventType === 'brief_update'
  );
}

// ── Tool Execution ──────────────────────────────────────────────────────

async function executeUpdateBrief(briefId, input) {
  const updated = await updateBriefFields(briefId, input.fields);
  const briefData = updated.brief || {};

  const filled = REQUIRED_FIELDS.filter((f) => {
    const val = briefData[f];
    if (val === undefined || val === null || val === '') return false;
    if (Array.isArray(val) && val.length === 0) return false;
    return true;
  });
  const missing = REQUIRED_FIELDS.filter((f) => !filled.includes(f));
  const completion_pct = (filled.length / REQUIRED_FIELDS.length) * 100;
  const is_complete = missing.length === 0;

  const completion = { filled, missing, completion_pct };
  await updateCompletion(briefId, completion);

  return {
    brief: briefData,
    is_complete,
    filled,
    missing,
    completion_pct,
  };
}

async function executeSaveBrief(briefId, input) {
  await updateBrief(briefId, { status: 'completed', brief: input.brief });
  return { saved: true, brief_id: briefId };
}

async function executeParseAttachment(_briefId, _input) {
  return { extracted_text: 'Attachment parsing not yet implemented' };
}

async function executeTool(briefId, toolName, toolInput) {
  switch (toolName) {
    case 'update_brief':
      return executeUpdateBrief(briefId, toolInput);
    case 'save_brief':
      return executeSaveBrief(briefId, toolInput);
    case 'parse_attachment':
      return executeParseAttachment(briefId, toolInput);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Main Entry Point ────────────────────────────────────────────────────

export async function* processIntakeMessage(
  briefId,
  message,
  { streamLevel = 'text' } = {},
) {
  try {
    // 1. Load brief from DB
    const brief = await getBrief(briefId);
    if (!brief) {
      yield { event: 'error', data: { message: `Brief ${briefId} not found` } };
      return;
    }

    // 2. Load history
    const history = await getMessagesForClaude(briefId);

    // 3. Get next message_index
    let messageIndex = await getNextMessageIndex(briefId);

    // 4. Store user message in DB
    await addMessage(briefId, {
      role: 'user',
      content: message,
      message_index: messageIndex++,
    });

    // 5. Build Claude request messages
    const messages = [
      ...history,
      { role: 'user', content: message },
    ];

    // 6. Process streaming response with tool-use loop
    const tools = getIntakeTools();
    const systemPrompt = buildIntakeSystemPrompt();
    let iterations = 0;
    const maxIterations = 5;
    // Collect all messages to persist after the loop
    const messagesToPersist = [];
    let latestBrief = brief.brief || {};
    let latestCompletion = brief.completion || {};
    let briefCompleted = false;

    while (iterations < maxIterations) {
      iterations++;

      const stream = anthropic.messages.stream({
        model: config.anthropic.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools,
      });

      // Track content blocks and cached tool results for this stream response
      const toolUseBlocks = []; // { id, name, input, result }
      let currentBlockType = null;
      let currentToolInput = '';
      let currentToolName = '';
      let currentToolUseId = '';
      let assistantText = '';

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            currentBlockType = 'tool_use';
            currentToolName = block.name;
            currentToolUseId = block.id;
            currentToolInput = '';
          } else if (block.type === 'text') {
            currentBlockType = 'text';
          } else if (block.type === 'thinking') {
            currentBlockType = 'thinking';
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            assistantText += delta.text;
            if (shouldEmit('delta', streamLevel)) {
              yield { event: 'delta', data: { text: delta.text } };
            }
          } else if (delta.type === 'thinking_delta') {
            if (shouldEmit('thinking', streamLevel)) {
              yield { event: 'thinking', data: { text: delta.thinking } };
            }
          } else if (delta.type === 'input_json_delta') {
            currentToolInput += delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          if (currentBlockType === 'tool_use') {
            let parsedInput = {};
            try {
              parsedInput = JSON.parse(currentToolInput);
            } catch {
              // empty or malformed input
            }

            if (shouldEmit('tool_call', streamLevel)) {
              yield {
                event: 'tool_call',
                data: {
                  tool: currentToolName,
                  tool_use_id: currentToolUseId,
                  input: parsedInput,
                },
              };
            }

            // Execute the tool once and cache the result
            const toolResult = await executeTool(
              briefId,
              currentToolName,
              parsedInput,
            );

            toolUseBlocks.push({
              id: currentToolUseId,
              name: currentToolName,
              input: parsedInput,
              result: toolResult,
            });

            if (shouldEmit('tool_result', streamLevel)) {
              yield {
                event: 'tool_result',
                data: {
                  tool: currentToolName,
                  tool_use_id: currentToolUseId,
                  result: toolResult,
                },
              };
            }

            // Track latest brief state
            if (currentToolName === 'update_brief' && toolResult.brief) {
              latestBrief = toolResult.brief;
              latestCompletion = {
                filled: toolResult.filled,
                missing: toolResult.missing,
                completion_pct: toolResult.completion_pct,
              };
            }
            if (currentToolName === 'save_brief') {
              briefCompleted = true;
            }
          }
          currentBlockType = null;
        }
      }

      // Get final message from the stream
      const finalMessage = await stream.finalMessage();
      const stopReason = finalMessage.stop_reason;
      const hasToolUse = toolUseBlocks.length > 0;

      // Persist assistant text message
      if (assistantText) {
        messagesToPersist.push({
          role: 'assistant',
          content: assistantText,
          message_index: messageIndex++,
        });
      }

      // Persist tool_use + tool_result messages (using cached results)
      for (const block of toolUseBlocks) {
        messagesToPersist.push({
          role: 'assistant',
          content: null,
          tool_use_id: block.id,
          tool_name: block.name,
          tool_input: block.input,
          message_index: messageIndex++,
        });
        messagesToPersist.push({
          role: 'tool',
          content: null,
          tool_use_id: block.id,
          tool_result: block.result,
          message_index: messageIndex++,
        });
      }

      // If Claude stopped due to tool_use, feed cached results back and continue
      if (stopReason === 'tool_use' && hasToolUse) {
        // Build assistant content for the next turn
        const assistantContent = [];
        if (assistantText) {
          assistantContent.push({ type: 'text', text: assistantText });
        }
        for (const block of toolUseBlocks) {
          assistantContent.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
        messages.push({ role: 'assistant', content: assistantContent });

        // Build tool results for the next turn (using cached results)
        const toolResultContent = toolUseBlocks.map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(block.result),
        }));
        messages.push({ role: 'user', content: toolResultContent });

        // Reset for next iteration
        assistantText = '';
        continue;
      }

      // No more tool calls — we're done
      break;
    }

    // 7. Persist all collected messages
    if (messagesToPersist.length > 0) {
      await addMessages(briefId, messagesToPersist);
    }

    // Yield brief update
    if (shouldEmit('brief_update', streamLevel)) {
      yield {
        event: 'brief_update',
        data: { brief: latestBrief, completion: latestCompletion },
      };
    }

    // Yield done
    yield {
      event: 'done',
      data: { brief_id: briefId, status: briefCompleted ? 'completed' : 'collecting' },
    };
  } catch (err) {
    yield {
      event: 'error',
      data: { message: err.message || 'Unknown error' },
    };
  }
}
