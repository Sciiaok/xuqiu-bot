'use client';

import { useState } from 'react';

export default function FilterBar({
  leads = [],
  carModels = [],
  onFilterChange,
  initialInquiryQuality = 'all',
  initialBusinessValue = 'all',
}) {
  const [inquiryQuality, setInquiryQuality] = useState(initialInquiryQuality);
  const [businessValue, setBusinessValue] = useState(initialBusinessValue);
  const [customer, setCustomer] = useState('');
  const [model, setModel] = useState('all');

  const handleInquiryQualityChange = (e) => {
    const newValue = e.target.value;
    setInquiryQuality(newValue);
    onFilterChange?.({ inquiryQuality: newValue, businessValue, customer, model });
  };

  const handleBusinessValueChange = (e) => {
    const newValue = e.target.value;
    setBusinessValue(newValue);
    onFilterChange?.({ inquiryQuality, businessValue: newValue, customer, model });
  };

  const handleCustomerChange = (e) => {
    const newCustomer = e.target.value;
    setCustomer(newCustomer);
    onFilterChange?.({ inquiryQuality, businessValue, customer: newCustomer, model });
  };

  const handleModelChange = (e) => {
    const newModel = e.target.value;
    setModel(newModel);
    onFilterChange?.({ inquiryQuality, businessValue, customer, model: newModel });
  };

  const filteredCount = leads.filter((lead) => {
    if (inquiryQuality !== 'all' && lead.inquiry_quality?.toUpperCase() !== inquiryQuality.toUpperCase()) return false;
    if (businessValue !== 'all' && lead.business_value?.toUpperCase() !== businessValue.toUpperCase()) return false;
    if (customer.trim() && !lead.lead_data?.company_name?.toLowerCase().includes(customer.toLowerCase())) return false;
    if (model !== 'all' && lead.lead_data?.car_model !== model) return false;
    return true;
  }).length;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-sm font-medium text-text-secondary">Filters:</span>

        {/* Inquiry Quality Filter */}
        <div className="relative">
          <select
            value={inquiryQuality}
            onChange={handleInquiryQualityChange}
            className="appearance-none bg-surface border border-border text-text-primary text-sm rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-1 focus:ring-accent-blue focus:border-accent-blue transition-colors"
          >
            <option value="all">All Quality</option>
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
            <option value="all">All Values</option>
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
