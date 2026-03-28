'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function FeedbackCard({ message, options, onRespond }) {
  return (
    <div className="bg-white border border-blue-200 rounded-xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 bg-blue-50 flex items-center gap-2 border-b border-blue-200">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="#2563eb" strokeWidth="1.5"/>
          <path d="M8 5v3M8 10h.01" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <span className="text-xs font-semibold text-blue-900">需要您的确认</span>
      </div>

      <div className="px-4 py-3 text-[13px] text-gray-700 leading-relaxed prose prose-sm prose-gray max-w-none
        [&_h2]:text-[14px] [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-1.5
        [&_h3]:text-[13.5px] [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1
        [&_h4]:text-[13px] [&_h4]:font-semibold [&_h4]:mt-2 [&_h4]:mb-1
        [&_p]:text-[13px] [&_p]:leading-relaxed [&_p]:mb-2 [&_p]:text-gray-700
        [&_strong]:text-gray-900
        [&_ul]:pl-4 [&_ul]:text-[13px] [&_ul]:mb-2
        [&_ol]:pl-4 [&_ol]:text-[13px] [&_ol]:mb-2
        [&_li]:mb-0.5 [&_li]:text-gray-700
        [&_hr]:my-3 [&_hr]:border-gray-200
        [&_table]:w-full [&_table]:text-[12px] [&_table]:border-collapse [&_table]:my-2
        [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-gray-900 [&_th]:border [&_th]:border-gray-200 [&_th]:bg-gray-50
        [&_td]:px-2 [&_td]:py-1.5 [&_td]:border [&_td]:border-gray-200 [&_td]:text-gray-700
      ">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message}</ReactMarkdown>
      </div>

      {options && options.length > 0 && (
        <div className="px-4 py-2.5 border-t border-blue-200 flex gap-2">
          {options.map((opt, i) => (
            <button
              key={i}
              onClick={() => onRespond(opt)}
              className={`text-xs px-3.5 py-1.5 rounded-lg font-medium transition-colors ${
                i === 0
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
