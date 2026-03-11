'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

export default function AgentEditor({ agent, onSave, onCancel }) {
  const [name, setName] = useState(agent?.name || '');
  const [productLine, setProductLine] = useState(agent?.product_line || '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt || '');
  const [outputSchema, setOutputSchema] = useState(
    agent?.output_schema ? JSON.stringify(agent.output_schema, null, 2) : '{}'
  );
  const [adContextMap, setAdContextMap] = useState(
    agent?.ad_context_map ? JSON.stringify(agent.ad_context_map, null, 2) : '{}'
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const t = useTranslations('agents');

  const handleSave = async () => {
    setError(null);

    if (!name.trim() || !productLine.trim() || !systemPrompt.trim()) {
      setError(t('validationError'));
      return;
    }

    let parsedSchema;
    let parsedAdContextMap;
    try {
      parsedSchema = JSON.parse(outputSchema);
      parsedAdContextMap = JSON.parse(adContextMap);
    } catch {
      setError(t('jsonError'));
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        productLine: productLine.trim(),
        systemPrompt: systemPrompt.trim(),
        outputSchema: parsedSchema,
        adContextMap: parsedAdContextMap,
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
          {agent ? t('editAgent') : t('newAgentTitle')}
        </h3>
        <button
          onClick={onCancel}
          className="text-text-muted hover:text-text-primary transition-colors"
        >
          {t('cancel')}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-accent-red/10 text-accent-red text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">{t('name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">{t('productLine')}</label>
          <input
            type="text"
            value={productLine}
            onChange={(e) => setProductLine(e.target.value)}
            placeholder={t('productLinePlaceholder')}
            className="input w-full"
            disabled={!!agent}
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">
          {t('systemPrompt')}
        </label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={12}
          className="input w-full font-mono text-sm"
          placeholder={t('systemPromptPlaceholder')}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">
          {t('outputSchema')}
        </label>
        <textarea
          value={outputSchema}
          onChange={(e) => setOutputSchema(e.target.value)}
          rows={8}
          className="input w-full font-mono text-sm"
          placeholder="{}"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">
          {t('adContextMap')}
        </label>
        <textarea
          value={adContextMap}
          onChange={(e) => setAdContextMap(e.target.value)}
          rows={8}
          className="input w-full font-mono text-sm"
          placeholder={t('adContextMapPlaceholder')}
        />
      </div>

      <div className="flex justify-end gap-3">
        <button
          onClick={onCancel}
          className="btn bg-background-secondary text-text-secondary hover:bg-surface-hover"
        >
          {t('cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn btn-primary disabled:opacity-50"
        >
          {saving ? t('saving') : agent ? t('updateAgent') : t('createAgent')}
        </button>
      </div>
    </div>
  );
}
