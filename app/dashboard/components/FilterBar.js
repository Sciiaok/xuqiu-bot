'use client';

import { useTranslations } from 'next-intl';

export default function FilterBar({
  leads = [],
  carModels = [],
  agentOptions = [],
  filters = {},
  onFilterChange,
}) {
  const t = useTranslations('filters');
  const inquiryQuality = filters.inquiryQuality || 'all';
  const businessValue = filters.businessValue || 'all';
  const customer = filters.customer || '';
  const model = filters.model || 'all';
  const agentIds = filters.agentIds || [];

  const handleInquiryQualityChange = (e) => {
    const newValue = e.target.value;
    onFilterChange?.({ inquiryQuality: newValue, businessValue, customer, model, agentIds });
  };

  const handleBusinessValueChange = (e) => {
    const newValue = e.target.value;
    onFilterChange?.({ inquiryQuality, businessValue: newValue, customer, model, agentIds });
  };

  const handleCustomerChange = (e) => {
    const newCustomer = e.target.value;
    onFilterChange?.({ inquiryQuality, businessValue, customer: newCustomer, model, agentIds });
  };

  const handleModelChange = (e) => {
    const newModel = e.target.value;
    onFilterChange?.({ inquiryQuality, businessValue, customer, model: newModel, agentIds });
  };

  const toggleAgent = (agentId) => {
    const nextAgentIds = agentIds.includes(agentId)
      ? agentIds.filter((id) => id !== agentId)
      : [...agentIds, agentId];

    onFilterChange?.({
      inquiryQuality,
      businessValue,
      customer,
      model,
      agentIds: nextAgentIds,
    });
  };

  const filteredCount = leads.filter((lead) => {
    if (inquiryQuality !== 'all' && lead.inquiry_quality?.toUpperCase() !== inquiryQuality.toUpperCase()) return false;
    if (businessValue !== 'all' && lead.business_value?.toUpperCase() !== businessValue.toUpperCase()) return false;
    if (customer.trim() && !(lead.lead_data?.company_name || '').toLowerCase().includes(customer.toLowerCase())) return false;
    if (model !== 'all' && lead.lead_data?.car_model !== model) return false;
    if (agentIds.length > 0 && (!lead.agent_id || !agentIds.includes(lead.agent_id))) return false;
    return true;
  }).length;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-sm font-medium text-text-secondary">{t('label')}</span>

        {/* Inquiry Quality Filter */}
        <div className="relative">
          <select
            value={inquiryQuality}
            onChange={handleInquiryQualityChange}
            className="appearance-none bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors"
          >
            <option value="all">{t('allQuality')}</option>
            <option value="PROOF">PROOF</option>
            <option value="QUALIFY">QUALIFY</option>
            <option value="GOOD">GOOD</option>
            <option value="BAD">BAD</option>
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
            <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        {/* Business Value Filter */}
        <div className="relative">
          <select
            value={businessValue}
            onChange={handleBusinessValueChange}
            className="appearance-none bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors"
          >
            <option value="all">{t('allValues')}</option>
            <option value="HIGH">HIGH</option>
            <option value="AVERAGE">AVERAGE</option>
            <option value="LOW">LOW</option>
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
          placeholder={t('customerPlaceholder')}
          className="bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 w-40 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors placeholder:text-text-muted"
        />

        {/* Model Filter */}
        <div className="relative">
          <select
            value={model}
            onChange={handleModelChange}
            className="appearance-none bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors"
          >
            <option value="all">{t('allModels')}</option>
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

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-text-secondary">{t('agent')}</span>
          <button
            type="button"
            onClick={() => onFilterChange?.({
              inquiryQuality,
              businessValue,
              customer,
              model,
              agentIds: [],
            })}
            className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
              agentIds.length === 0
                ? 'bg-accent-blue text-white border-accent-blue'
                : 'bg-surface border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            {t('allAgents')}
          </button>
          {agentOptions.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => toggleAgent(agent.id)}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                agentIds.includes(agent.id)
                  ? 'bg-accent-blue/10 text-accent-blue border-accent-blue/30'
                  : 'bg-surface border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              {agent.product_line}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <span className="text-sm text-text-secondary">
          <span className="font-semibold text-text-primary">{filteredCount}</span> {filteredCount !== 1 ? t('leadsLabel') : t('leadLabel')}
        </span>
      </div>
    </div>
  );
}
