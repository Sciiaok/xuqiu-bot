'use client';

import { useState } from 'react';

export default function FilterBar({
  leads = [],
  carModels = [],
  onFilterChange,
  initialStage = 'all',
  initialScoreRange = 'all',
}) {
  const [stage, setStage] = useState(initialStage);
  const [scoreRange, setScoreRange] = useState(initialScoreRange);
  const [customer, setCustomer] = useState('');
  const [model, setModel] = useState('all');

  const handleStageChange = (e) => {
    const newStage = e.target.value;
    setStage(newStage);
    onFilterChange?.({ stage: newStage, scoreRange, customer, model });
  };

  const handleScoreRangeChange = (e) => {
    const newScoreRange = e.target.value;
    setScoreRange(newScoreRange);
    onFilterChange?.({ stage, scoreRange: newScoreRange, customer, model });
  };

  const handleCustomerChange = (e) => {
    const newCustomer = e.target.value;
    setCustomer(newCustomer);
    onFilterChange?.({ stage, scoreRange, customer: newCustomer, model });
  };

  const handleModelChange = (e) => {
    const newModel = e.target.value;
    setModel(newModel);
    onFilterChange?.({ stage, scoreRange, customer, model: newModel });
  };

  const filteredCount = leads.filter((lead) => {
    if (stage !== 'all' && lead.stage?.toUpperCase() !== stage.toUpperCase()) return false;
    const score = lead.score || 0;
    if (scoreRange === 'high' && score < 75) return false;
    if (scoreRange === 'medium' && (score < 50 || score >= 75)) return false;
    if (scoreRange === 'low' && score >= 50) return false;
    if (customer.trim() && !lead.lead_data?.company_name?.toLowerCase().includes(customer.toLowerCase())) return false;
    if (model !== 'all' && lead.lead_data?.car_model !== model) return false;
    return true;
  }).length;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-sm font-medium text-text-secondary">Filters:</span>

        {/* Stage Filter */}
        <div className="relative">
          <select
            value={stage}
            onChange={handleStageChange}
            className="appearance-none bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors"
          >
            <option value="all">All Stages</option>
            <option value="GREET">GREET</option>
            <option value="QUALIFY">QUALIFY</option>
            <option value="PROOF">PROOF</option>
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
            <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        {/* Score Range Filter */}
        <div className="relative">
          <select
            value={scoreRange}
            onChange={handleScoreRangeChange}
            className="appearance-none bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors"
          >
            <option value="all">All Scores</option>
            <option value="high">High (75+)</option>
            <option value="medium">Medium (50-74)</option>
            <option value="low">Low (&lt;50)</option>
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
            <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        {/* Customer Filter */}
        <input
          type="text"
          value={customer}
          onChange={handleCustomerChange}
          placeholder="Customer..."
          className="bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 w-40 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors placeholder:text-text-muted"
        />

        {/* Model Filter */}
        <div className="relative">
          <select
            value={model}
            onChange={handleModelChange}
            className="appearance-none bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors"
          >
            <option value="all">All Models</option>
            {carModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
            <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        <div className="flex-1" />

        <span className="text-sm text-text-secondary">
          <span className="font-semibold text-text-primary">{filteredCount}</span> lead{filteredCount !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}
