'use client';

import { useState } from 'react';

export default function AgentEditor({ agent, onSave, onCancel }) {
  const [name, setName] = useState(agent?.name || '');
  const [productLine, setProductLine] = useState(agent?.product_line || '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt || '');
  const [outputSchema, setOutputSchema] = useState(
    agent?.output_schema ? JSON.stringify(agent.output_schema, null, 2) : '{}'
  );
  const [waPhoneNumberId, setWaPhoneNumberId] = useState(agent?.wa_phone_number_id || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async () => {
    setError(null);

    if (!name.trim() || !productLine.trim() || !systemPrompt.trim()) {
      setError('Name, product line, and system prompt are required');
      return;
    }

    let parsedSchema;
    try {
      parsedSchema = JSON.parse(outputSchema);
    } catch {
      setError('Output schema must be valid JSON');
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        productLine: productLine.trim(),
        systemPrompt: systemPrompt.trim(),
        outputSchema: parsedSchema,
        waPhoneNumberId: waPhoneNumberId.trim() || null,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface rounded-xl border border-border p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-text-primary">
          {agent ? 'Edit Agent' : 'New Agent'}
        </h3>
        <button
          onClick={onCancel}
          className="text-text-muted hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-accent-red/10 text-accent-red text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Vehicle Export Agent"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Product Line</label>
          <input
            type="text"
            value={productLine}
            onChange={(e) => setProductLine(e.target.value)}
            placeholder="auto"
            className="input w-full"
            disabled={!!agent}
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">
          WhatsApp Phone Number ID
        </label>
        <input
          type="text"
          value={waPhoneNumberId}
          onChange={(e) => setWaPhoneNumberId(e.target.value)}
          placeholder="Optional - maps this agent to a specific WA number"
          className="input w-full"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">
          System Prompt
        </label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={12}
          className="input w-full font-mono text-sm"
          placeholder="Enter the system prompt for this agent..."
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">
          Output Schema (JSON)
        </label>
        <textarea
          value={outputSchema}
          onChange={(e) => setOutputSchema(e.target.value)}
          rows={8}
          className="input w-full font-mono text-sm"
          placeholder="{}"
        />
      </div>

      <div className="flex justify-end gap-3">
        <button
          onClick={onCancel}
          className="btn bg-background-secondary text-text-secondary hover:bg-surface-hover"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn btn-primary disabled:opacity-50"
        >
          {saving ? 'Saving...' : agent ? 'Update Agent' : 'Create Agent'}
        </button>
      </div>
    </div>
  );
}
