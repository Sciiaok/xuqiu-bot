'use client';

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

      <div className="px-4 py-3 text-[13px] text-gray-700 leading-relaxed">
        {message}
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
