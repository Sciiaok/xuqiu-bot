'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import BriefCard from './cards/BriefCard';
import ResearchCard from './cards/ResearchCard';
import StrategyCard from './cards/StrategyCard';
import CreativeCard from './cards/CreativeCard';
import ExecutionCard from './cards/ExecutionCard';
import ThinkingCard from './cards/ThinkingCard';
import FeedbackCard from './cards/FeedbackCard';

function MarkdownContent({ children }) {
  return (
    <div className="prose prose-sm prose-gray max-w-none
      [&_h1]:text-base [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2
      [&_h2]:text-[14px] [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-1.5
      [&_h3]:text-[13.5px] [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1
      [&_p]:text-[13.5px] [&_p]:leading-relaxed [&_p]:mb-2 [&_p]:text-gray-700
      [&_strong]:text-gray-900
      [&_ul]:pl-4 [&_ul]:text-[13.5px] [&_ul]:mb-2
      [&_ol]:pl-4 [&_ol]:text-[13.5px] [&_ol]:mb-2
      [&_li]:mb-0.5 [&_li]:text-gray-700
      [&_hr]:my-3 [&_hr]:border-gray-200
      [&_blockquote]:border-l-2 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3 [&_blockquote]:text-gray-500 [&_blockquote]:italic
      [&_code]:text-[12px] [&_code]:bg-gray-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-gray-800 [&_code]:font-mono
      [&_pre]:bg-gray-900 [&_pre]:text-gray-100 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-gray-100
      [&_table]:w-full [&_table]:text-[12.5px] [&_table]:border-collapse [&_table]:my-2 [&_table]:rounded-lg [&_table]:overflow-hidden
      [&_thead]:bg-gray-50
      [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:text-gray-900 [&_th]:border [&_th]:border-gray-200
      [&_td]:px-3 [&_td]:py-2 [&_td]:border [&_td]:border-gray-200 [&_td]:text-gray-700
      [&_tr:hover]:bg-gray-50/50
      [&_a]:text-indigo-600 [&_a]:no-underline hover:[&_a]:underline
    ">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

export default function MessageBubble({ message, onApprove, onReject, onFeedbackRespond }) {
  const { type } = message;

  // User message
  if (type === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[65%] bg-indigo-600 text-white rounded-2xl rounded-br-sm px-4 py-3 text-[13.5px] leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  // AI messages and cards share the avatar layout
  return (
    <div className="flex gap-2.5 max-w-[88%]">
      {/* AI avatar */}
      <div className="w-8 h-8 rounded-[10px] bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center flex-shrink-0 text-white text-xs font-bold">
        AI
      </div>

      <div className="flex flex-col gap-2.5 flex-1 min-w-0">
        {/* Markdown-rendered message */}
        {type === 'assistant' && (
          <div className="bg-white border border-gray-200 rounded-sm rounded-tr-2xl rounded-br-2xl rounded-bl-2xl px-4 py-3 shadow-sm">
            <MarkdownContent>{message.content}</MarkdownContent>
          </div>
        )}

        {/* Brief card */}
        {type === 'brief_update' && (
          <BriefCard brief={message.brief} completion={message.completion} />
        )}

        {/* Research card */}
        {type === 'research_complete' && (
          <ResearchCard report={message.report} duration={message.duration} />
        )}

        {/* Strategy card - in progress */}
        {type === 'strategy_progress' && (
          <StrategyCard inProgress steps={message.steps} />
        )}

        {/* Strategy card - complete */}
        {type === 'strategy_complete' && (
          <StrategyCard plan={message.plan} />
        )}

        {/* Creative card */}
        {type === 'creative_progress' && (
          <CreativeCard inProgress />
        )}
        {type === 'creative_complete' && (
          <CreativeCard creatives={message.creatives} />
        )}

        {/* Execution card */}
        {type === 'execution_approval' && (
          <ExecutionCard
            plan={message.plan}
            status="awaiting_approval"
            onApprove={onApprove}
            onReject={onReject}
          />
        )}
        {type === 'execution_progress' && (
          <ExecutionCard status="executing" />
        )}
        {type === 'execution_complete' && (
          <ExecutionCard result={message.result} status="completed" />
        )}

        {/* Feedback from orchestrator */}
        {type === 'feedback_required' && (
          <FeedbackCard
            message={message.message}
            options={message.options}
            onRespond={onFeedbackRespond}
          />
        )}

        {/* Phase skipped */}
        {type === 'phase_skipped' && (
          <div className="text-xs text-gray-400 flex items-center gap-2 py-1">
            <div className="h-px flex-1 bg-gray-200" />
            <span>跳过: {message.reason}</span>
            <div className="h-px flex-1 bg-gray-200" />
          </div>
        )}

        {/* Thinking / tool use */}
        {(type === 'thinking' || type === 'tool_call' || type === 'tool_result') && (
          <ThinkingCard type={type} tool={message.tool} content={message.content} />
        )}

        {/* Phase start notification */}
        {type === 'phase_start' && (
          <div className="text-xs text-gray-400 flex items-center gap-2 py-1">
            <div className="h-px flex-1 bg-gray-200" />
            <span>{message.content}</span>
            <div className="h-px flex-1 bg-gray-200" />
          </div>
        )}

        {/* Error */}
        {type === 'error' && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-[13px] text-red-700">
            {message.content}
          </div>
        )}
      </div>
    </div>
  );
}
