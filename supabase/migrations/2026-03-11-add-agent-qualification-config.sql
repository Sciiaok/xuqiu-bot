ALTER TABLE agents
ADD COLUMN IF NOT EXISTS qualification_config JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE agents
SET qualification_config = '{
  "inquiry_quality_requirements": {
    "GOOD": { "required_fields": ["brand", "car_model"] },
    "QUALIFY": { "required_fields": ["color_quantity", "destination_port"] },
    "PROOF": { "required_fields": ["company_name", "international_commercial_term"] }
  }
}'::jsonb
WHERE product_line = 'vehicle';

UPDATE agents
SET qualification_config = '{
  "inquiry_quality_requirements": {
    "GOOD": { "required_fields": ["part_name", "car_model"] },
    "QUALIFY": { "required_fields": ["year_range", "quantity", "destination_country"] },
    "PROOF": {
      "required_fields": ["international_commercial_term"],
      "require_any_of": [["oem_code", "company_name"]]
    }
  }
}'::jsonb
WHERE product_line = 'auto_parts';

UPDATE agents
SET qualification_config = '{
  "inquiry_quality_requirements": {
    "GOOD": { "required_fields": ["machinery_type"] },
    "QUALIFY": { "required_fields": ["model", "specifications", "quantity", "destination_country"] },
    "PROOF": {
      "required_fields": ["company_name"],
      "require_any_of": [["china_procurement_history", "current_fleet", "business_scale"]]
    }
  }
}'::jsonb
WHERE product_line = 'agri_machinery';
