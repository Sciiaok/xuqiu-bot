// app/dashboard/components/EditModal.js
'use client';

import { useState, useEffect } from 'react';

const QTY_OPTIONS = ['1-5', '6-20', '20+'];
const BUYER_TYPE_OPTIONS = ['dealer', 'store_owner', 'trading_org'];
const INCOTERM_OPTIONS = ['FOB', 'CIF', 'EXW', 'DDP'];

function normalizeIncotermValue(value) {
  if (!value) return '';

  const raw = String(value).toUpperCase();
  const normalized = raw
    .replace(/\bAND\b/g, ',')
    .replace(/[|/&;+，、]+/g, ',')
    .replace(/\s+/g, '');

  const selected = new Set();
  for (const token of normalized.split(',').filter(Boolean)) {
    if (token === 'BOTH') {
      selected.add('FOB');
      selected.add('CIF');
      continue;
    }
    if (INCOTERM_OPTIONS.includes(token)) selected.add(token);
  }

  return INCOTERM_OPTIONS.filter((term) => selected.has(term)).join(',');
}

export default function EditModal({ lead, isOpen, onClose, onSave }) {
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (lead) {
      setFormData({
        brand: lead.brand || '',
        car_model: lead.car_model || '',
        destination_country: lead.destination_country || '',
        destination_port: lead.destination_port || '',
        qty_bucket: lead.qty_bucket || '',
        buyer_type: lead.buyer_type || '',
        timeline: lead.timeline || '',
        loading_port: lead.loading_port || '',
        incoterm: lead.incoterm || '',
        approved: lead.approved || false,
      });
    }
  }, [lead]);

  if (!isOpen) return null;

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const selectedIncoterms = (formData.incoterm || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

  const handleIncotermToggle = (term) => {
    const current = new Set(selectedIncoterms);
    if (current.has(term)) {
      current.delete(term);
    } else {
      current.add(term);
    }
    const normalized = INCOTERM_OPTIONS.filter((item) => current.has(item)).join(',');
    handleChange('incoterm', normalized);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const payload = {
        ...formData,
        incoterm: normalizeIncotermValue(formData.incoterm),
      };

      const response = await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'Failed to save');
      }

      onSave?.(result.lead);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface border border-border rounded-lg w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Edit Lead</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="p-3 bg-accent-red/10 border border-accent-red/30 rounded text-accent-red text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Brand</label>
            <input
              type="text"
              value={formData.brand}
              onChange={(e) => handleChange('brand', e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              placeholder="e.g. Toyota"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Model</label>
            <input
              type="text"
              value={formData.car_model}
              onChange={(e) => handleChange('car_model', e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              placeholder="e.g. Land Cruiser 300"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Country</label>
              <input
                type="text"
                value={formData.destination_country}
                onChange={(e) => handleChange('destination_country', e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Port</label>
              <input
                type="text"
                value={formData.destination_port}
                onChange={(e) => handleChange('destination_port', e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Quantity</label>
              <select
                value={formData.qty_bucket}
                onChange={(e) => handleChange('qty_bucket', e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              >
                <option value="">Select...</option>
                {QTY_OPTIONS.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Buyer Type</label>
              <select
                value={formData.buyer_type}
                onChange={(e) => handleChange('buyer_type', e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              >
                <option value="">Select...</option>
                {BUYER_TYPE_OPTIONS.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Timeline</label>
              <input
                type="text"
                value={formData.timeline}
                onChange={(e) => handleChange('timeline', e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                placeholder="e.g. 1 month"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Incoterm</label>
              <div className="grid grid-cols-2 gap-2">
                {INCOTERM_OPTIONS.map(term => (
                  <button
                    key={term}
                    type="button"
                    onClick={() => handleIncotermToggle(term)}
                    className={`px-3 py-2 rounded-lg border text-sm ${
                      selectedIncoterms.includes(term)
                        ? 'border-accent-blue bg-accent-blue/15 text-text-primary'
                        : 'border-border bg-background text-text-secondary'
                    }`}
                  >
                    {term}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-text-muted">
                Selected: {formData.incoterm || 'None'}
              </p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Loading Port</label>
            <input
              type="text"
              value={formData.loading_port}
              onChange={(e) => handleChange('loading_port', e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="approved"
              checked={formData.approved}
              onChange={(e) => handleChange('approved', e.target.checked)}
              className="w-4 h-4 rounded border-border text-accent-blue focus:ring-accent-blue"
            />
            <label htmlFor="approved" className="text-sm text-text-primary">Approved</label>
          </div>

          <div className="flex gap-3 pt-4 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 btn btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 btn btn-primary disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
