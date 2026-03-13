'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  BUSINESS_VALUE_OPTIONS,
  INQUIRY_QUALITY_OPTIONS,
  ROUTE_OPTIONS,
  createDefaultInquiriesFilters,
  hasActiveQuantityFilter,
} from '@/lib/inquiries-filters';

function ChipButton({ active = false, children, onClick, activeClassName = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? activeClassName
          : 'bg-background text-text-secondary border-border hover:text-text-primary hover:border-border-strong'
      }`}
    >
      {children}
    </button>
  );
}

function ActiveFilterChip({ label, onRemove }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="inline-flex items-center gap-1.5 rounded-full border border-accent-blue/20 bg-accent-blue/8 px-3 py-1.5 text-sm text-accent-blue transition-colors hover:bg-accent-blue/12"
    >
      <span>{label}</span>
      <span className="text-xs">x</span>
    </button>
  );
}

function FieldShell({ label, children, className = '' }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function getQualityFilterClass(value) {
  switch (value) {
    case 'PROOF': return 'bg-accent-green/20 text-accent-green border-accent-green/30';
    case 'QUALIFY': return 'bg-accent-purple/20 text-accent-purple border-accent-purple/30';
    case 'GOOD': return 'bg-accent-blue/20 text-accent-blue border-accent-blue/30';
    case 'BAD': return 'bg-accent-red/20 text-accent-red border-accent-red/30';
    default: return 'bg-text-muted/20 text-text-muted border-text-muted/30';
  }
}

function getBusinessValueFilterClass(value) {
  switch (value) {
    case 'HIGH': return 'bg-accent-green/20 text-accent-green border-accent-green/30';
    case 'AVERAGE': return 'bg-accent-amber/20 text-accent-amber border-accent-amber/30';
    case 'LOW': return 'bg-text-muted/20 text-text-muted border-text-muted/30';
    default: return 'bg-text-muted/20 text-text-muted border-text-muted/30';
  }
}

function getRouteFilterClass(value) {
  switch (value) {
    case 'HUMAN_NOW': return 'bg-accent-red/20 text-accent-red border-accent-red/30';
    case 'CONTINUE': return 'bg-accent-blue/20 text-accent-blue border-accent-blue/30';
    case 'NURTURE': return 'bg-accent-purple/20 text-accent-purple border-accent-purple/30';
    case 'FAQ_END': return 'bg-text-muted/20 text-text-muted border-text-muted/30';
    default: return 'bg-text-muted/20 text-text-muted border-text-muted/30';
  }
}

function getProductLineLabel(agent) {
  return agent?.product_line || agent?.id || '';
}

export default function InquiriesFiltersPanel({
  filters,
  countries = [],
  carModels = [],
  agentOptions = [],
  hasActiveFilters = false,
  onFilterChange,
  onClearFilters,
}) {
  const tf = useTranslations('filters');
  const ti = useTranslations('inquiries');
  const defaults = useMemo(() => createDefaultInquiriesFilters(), []);

  const activeChips = useMemo(() => {
    const chips = [];

    filters.inquiryQualities.forEach((value) => {
      chips.push({ label: `${tf('qualityLabel')}: ${value}`, remove: () => onFilterChange({ inquiryQualities: filters.inquiryQualities.filter((item) => item !== value) }) });
    });
    filters.businessValues.forEach((value) => {
      chips.push({ label: `${tf('valueLabel')}: ${value}`, remove: () => onFilterChange({ businessValues: filters.businessValues.filter((item) => item !== value) }) });
    });
    filters.routes.forEach((value) => {
      chips.push({ label: `${tf('routeLabel')}: ${value}`, remove: () => onFilterChange({ routes: filters.routes.filter((item) => item !== value) }) });
    });
    filters.agentIds.forEach((value) => {
      const label = agentOptions.find((agent) => agent.id === value)?.product_line || value;
      chips.push({ label: `${tf('agentLabel')}: ${label}`, remove: () => onFilterChange({ agentIds: filters.agentIds.filter((item) => item !== value) }) });
    });

    if (filters.customer.trim()) {
      chips.push({ label: `${tf('customerLabel')}: ${filters.customer.trim()}`, remove: () => onFilterChange({ customer: defaults.customer }) });
    }
    if (filters.waPrefix.trim()) {
      chips.push({ label: `${tf('waPrefixLabel')}: ${filters.waPrefix.trim()}`, remove: () => onFilterChange({ waPrefix: defaults.waPrefix }) });
    }
    if (filters.country !== defaults.country) {
      chips.push({ label: `${tf('countryLabel')}: ${filters.country}`, remove: () => onFilterChange({ country: defaults.country }) });
    }
    if (filters.model !== defaults.model) {
      chips.push({ label: `${tf('modelLabel')}: ${filters.model}`, remove: () => onFilterChange({ model: defaults.model }) });
    }
    if (filters.dateFrom) {
      chips.push({ label: `${tf('dateFrom')}: ${filters.dateFrom}`, remove: () => onFilterChange({ dateFrom: defaults.dateFrom }) });
    }
    if (filters.dateTo) {
      chips.push({ label: `${tf('dateTo')}: ${filters.dateTo}`, remove: () => onFilterChange({ dateTo: defaults.dateTo }) });
    }
    if (hasActiveQuantityFilter(filters)) {
      const minLabel = filters.quantityMin?.toString().trim() || '0';
      const maxLabel = filters.quantityMax?.toString().trim() || '0';
      chips.push({
        label: `${tf('quantityLabel')}: ${minLabel}-${maxLabel}`,
        remove: () => onFilterChange({ quantityMin: defaults.quantityMin, quantityMax: defaults.quantityMax }),
      });
    }

    return chips;
  }, [agentOptions, defaults, filters, onFilterChange, tf]);

  const toggleArrayFilter = (key, value) => {
    const current = Array.isArray(filters[key]) ? filters[key] : [];
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    onFilterChange({ [key]: next });
  };

  return (
    <section className="card border border-border-subtle bg-surface/95 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <FieldShell label={tf('customerLabel')}>
          <input
            type="text"
            value={filters.customer}
            onChange={(event) => onFilterChange({ customer: event.target.value })}
            placeholder={tf('customerPlaceholder')}
            className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-text-primary/20"
          />
        </FieldShell>

        <FieldShell label={tf('waPrefixLabel')}>
          <input
            type="text"
            value={filters.waPrefix}
            onChange={(event) => onFilterChange({ waPrefix: event.target.value })}
            placeholder={tf('waPrefixPlaceholder')}
            className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-text-primary/20"
          />
        </FieldShell>

        <FieldShell label={tf('countryLabel')}>
          <select
            value={filters.country}
            onChange={(event) => onFilterChange({ country: event.target.value })}
            className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-text-primary/20"
          >
            <option value="all">{tf('allCountries')}</option>
            {countries.map((country) => (
              <option key={country} value={country}>{country}</option>
            ))}
          </select>
        </FieldShell>

        <FieldShell label={tf('modelLabel')}>
          <select
            value={filters.model}
            onChange={(event) => onFilterChange({ model: event.target.value })}
            className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-text-primary/20"
          >
            <option value="all">{tf('allModels')}</option>
            {carModels.map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
        </FieldShell>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <FieldShell label={tf('quantityLabel')}>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number"
              min="0"
              inputMode="numeric"
              value={filters.quantityMin}
              onChange={(event) => onFilterChange({ quantityMin: event.target.value })}
              placeholder={tf('quantityMinPlaceholder')}
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-text-primary/20"
            />
            <input
              type="number"
              min="0"
              inputMode="numeric"
              value={filters.quantityMax}
              onChange={(event) => onFilterChange({ quantityMax: event.target.value })}
              placeholder={tf('quantityMaxPlaceholder')}
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-text-primary/20"
            />
          </div>
        </FieldShell>

        <FieldShell label={tf('dateRangeLabel')}>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="date"
              value={filters.dateFrom}
              max={filters.dateTo || undefined}
              onChange={(event) => onFilterChange({ dateFrom: event.target.value })}
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-text-primary/20"
              aria-label={tf('dateFrom')}
            />
            <input
              type="date"
              value={filters.dateTo}
              min={filters.dateFrom || undefined}
              onChange={(event) => onFilterChange({ dateTo: event.target.value })}
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-text-primary/20"
              aria-label={tf('dateTo')}
            />
          </div>
        </FieldShell>
      </div>

      <div className="mt-4 space-y-3 border-t border-border-subtle pt-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="flex min-h-[5.5rem] flex-col rounded-2xl bg-background-secondary/80 p-3">
            <p className="mb-2 text-sm font-medium text-text-primary">{tf('qualityLabel')}</p>
            <div className="flex flex-wrap gap-2">
              {INQUIRY_QUALITY_OPTIONS.map((value) => (
                <ChipButton
                  key={value}
                  active={filters.inquiryQualities.includes(value)}
                  onClick={() => toggleArrayFilter('inquiryQualities', value)}
                  activeClassName={getQualityFilterClass(value)}
                >
                  {value}
                </ChipButton>
              ))}
            </div>
          </div>

          <div className="flex min-h-[5.5rem] flex-col rounded-2xl bg-background-secondary/80 p-3">
            <p className="mb-2 text-sm font-medium text-text-primary">{tf('valueLabel')}</p>
            <div className="flex flex-wrap gap-2">
              {BUSINESS_VALUE_OPTIONS.map((value) => (
                <ChipButton
                  key={value}
                  active={filters.businessValues.includes(value)}
                  onClick={() => toggleArrayFilter('businessValues', value)}
                  activeClassName={getBusinessValueFilterClass(value)}
                >
                  {value}
                </ChipButton>
              ))}
            </div>
          </div>

          <div className="flex min-h-[5.5rem] flex-col rounded-2xl bg-background-secondary/80 p-3">
            <p className="mb-2 text-sm font-medium text-text-primary">{tf('routeLabel')}</p>
            <div className="flex flex-wrap gap-2">
              {ROUTE_OPTIONS.map((value) => (
                <ChipButton
                  key={value}
                  active={filters.routes.includes(value)}
                  onClick={() => toggleArrayFilter('routes', value)}
                  activeClassName={getRouteFilterClass(value)}
                >
                  {value}
                </ChipButton>
              ))}
            </div>
          </div>

          <div className="flex min-h-[5.5rem] flex-col rounded-2xl bg-background-secondary/80 p-3">
            <p className="mb-2 text-sm font-medium text-text-primary">{tf('agentLabel')}</p>
            <div className="flex flex-wrap gap-2">
              {agentOptions.map((agent) => (
                <ChipButton
                  key={agent.id}
                  active={filters.agentIds.includes(agent.id)}
                  onClick={() => toggleArrayFilter('agentIds', agent.id)}
                  activeClassName="bg-accent-blue/10 text-accent-blue border-accent-blue/30"
                >
                  {getProductLineLabel(agent)}
                </ChipButton>
              ))}
            </div>
          </div>
        </div>

        {hasActiveFilters && activeChips.length > 0 && (
          <div>
            <div className="flex flex-wrap gap-2">
              {activeChips.map((chip) => (
                <ActiveFilterChip key={chip.label} label={chip.label} onRemove={chip.remove} />
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-start pt-1">
          <button
            type="button"
            onClick={onClearFilters}
            disabled={!hasActiveFilters}
            className="rounded-full border border-border bg-background px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {ti('clearFilters')}
          </button>
        </div>
      </div>
    </section>
  );
}
