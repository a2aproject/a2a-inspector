import { describe, expect, it } from 'vitest';
import { formInputs, formValues, readForm } from './form';

// An expense form, as an agent sends it in a data part.
const expense = {
  type: 'form',
  form: {
    type: 'object',
    properties: {
      date: { type: 'string', format: 'date', title: 'Date', description: 'Date of expense' },
      amount: { type: 'string', format: 'number', title: 'Amount', description: 'Amount of expense' },
      purpose: { type: 'string', title: 'Purpose' },
      request_id: { type: 'string' },
      nights: { type: 'integer', title: 'Nights' },
      urgent: { type: 'boolean', title: 'Urgent' },
      site: { type: 'string', format: 'javascript' },
    },
    required: ['date', 'amount', 'purpose', 'request_id'],
  },
  form_data: { date: '2026-10-21', amount: 12.5, purpose: '<purpose>', request_id: 'req-1', urgent: true },
  instructions: 'Fill in the expense.',
};

describe('readForm', () => {
  it('reads fields, input types and initial values', () => {
    const form = readForm(expense);
    expect(form?.instructions).toBe('Fill in the expense.');
    expect(form?.fields.map((f) => [f.name, f.label, f.inputType, f.required])).toEqual([
      ['date', 'Date', 'date', true],
      ['amount', 'Amount', 'number', true],
      ['purpose', 'Purpose', 'text', true],
      ['request_id', 'request_id', 'text', true],
      ['nights', 'Nights', 'number', false],
      ['urgent', 'Urgent', 'checkbox', false],
      // Unknown formats fall back to text.
      ['site', 'site', 'text', false],
    ]);
    expect(form?.fields[0]?.description).toBe('Date of expense');
    expect(form?.initial).toEqual({ date: '2026-10-21', amount: '12.5', purpose: '<purpose>', request_id: 'req-1', nights: '', urgent: true, site: '' });
  });

  it('ignores data that is not a form', () => {
    expect(readForm({ type: 'form' })).toBeUndefined();
    expect(readForm({ type: 'table', form: { properties: {} } })).toBeUndefined();
    expect(readForm('form')).toBeUndefined();
    expect(readForm(null)).toBeUndefined();
  });
});

describe('formValues', () => {
  it('types values by the schema', () => {
    const form = readForm(expense)!;
    const values = formValues(form, { ...form.initial, nights: '3', urgent: false });
    // A string with format "number" stays a string, as the schema says.
    expect(values).toEqual({ date: '2026-10-21', amount: '12.5', purpose: '<purpose>', request_id: 'req-1', nights: 3, urgent: false, site: '' });
    expect(formValues(form, { ...form.initial, nights: 'x' })).not.toHaveProperty('nights');
    expect(formInputs(form, values)).toMatchObject({ nights: '3', urgent: false, amount: '12.5' });
  });
});
