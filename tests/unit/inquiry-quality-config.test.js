import test from 'node:test';
import assert from 'node:assert/strict';

import { getMissingFields } from '../../src/inquiry-quality.js';

const AUTO_PARTS_QUALIFICATION_CONFIG = {
  inquiry_quality_requirements: {
    GOOD: {
      required_fields: ['part_name', 'car_model'],
    },
    QUALIFY: {
      required_fields: ['year_range', 'quantity', 'destination_country'],
    },
    PROOF: {
      required_fields: ['international_commercial_term'],
      require_any_of: [['oem_code', 'company_name']],
    },
  },
};

const AGRI_QUALIFICATION_CONFIG = {
  inquiry_quality_requirements: {
    GOOD: {
      required_fields: ['machinery_type'],
    },
    QUALIFY: {
      required_fields: ['model', 'specifications', 'quantity', 'destination_country'],
    },
    PROOF: {
      required_fields: ['company_name'],
      require_any_of: [['china_procurement_history', 'current_fleet', 'business_scale']],
    },
  },
};

test('returns no missing fields when agent qualification config is absent', () => {
  assert.deepEqual(getMissingFields('GOOD', { car_model: 'Corolla' }), []);
});

test('auto parts requirements resolve aliases and details JSON fields', () => {
  const lead = {
    product_name: 'Fuel Pump',
    car_model: 'Corolla',
    details: {
      year_range: '2014-2017',
      quantity: '100',
    },
  };

  assert.deepEqual(
    getMissingFields('GOOD', {}, { qualificationConfig: AUTO_PARTS_QUALIFICATION_CONFIG, lead }),
    []
  );

  assert.deepEqual(
    getMissingFields('QUALIFY', {}, { qualificationConfig: AUTO_PARTS_QUALIFICATION_CONFIG, lead }),
    ['destination_country']
  );

  assert.deepEqual(
    getMissingFields(
      'PROOF',
      {},
      { qualificationConfig: AUTO_PARTS_QUALIFICATION_CONFIG, lead }
    ),
    ['international_commercial_term', 'oem_code', 'company_name']
  );
});

test('agri requirements read nested customer profile fields from details', () => {
  const lead = {
    destination_country: 'Kenya',
    details: {
      machinery_type: 'tractor',
      model: 'Tractor 90HP 4WD',
      specifications: '90HP, 4WD, cabin',
      quantity: '20',
      customer_profile: {
        company_name: 'Kenya Farm Equip Ltd',
        china_procurement_history: 'Bought 12 YTO tractors in 2024',
      },
    },
  };

  assert.deepEqual(
    getMissingFields(
      'QUALIFY',
      {},
      { qualificationConfig: AGRI_QUALIFICATION_CONFIG, lead }
    ),
    []
  );

  assert.deepEqual(
    getMissingFields(
      'PROOF',
      {},
      { qualificationConfig: AGRI_QUALIFICATION_CONFIG, lead }
    ),
    []
  );
});
