// Forms in data parts: the data is
// {"type": "form", "form": <JSON Schema of an object>, "form_data": {...}, "instructions": "..."}.
import { asObject, asString, asStrings } from '../card';

export type FormInputType = 'text' | 'number' | 'date' | 'time' | 'datetime-local' | 'email' | 'url' | 'checkbox';

export interface FormField {
  name: string;
  /** The property's title, or its name. */
  label: string;
  inputType: FormInputType;
  /** The property's JSON Schema type, which decides the type of the submitted value. */
  schemaType?: string;
  required: boolean;
  description?: string;
}

/** What the inputs hold: text for most, a boolean for checkboxes. */
export type FormInputs = Record<string, string | boolean>;

export interface FormView {
  instructions?: string;
  fields: FormField[];
  /** The inputs' initial values, from form_data. */
  initial: FormInputs;
}

// Only input types that can't do anything but take a value.
const formatTypes: Record<string, FormInputType> = {
  date: 'date',
  time: 'time',
  'date-time': 'datetime-local',
  email: 'email',
  uri: 'url',
  url: 'url',
  number: 'number',
  integer: 'number',
};

function inputType(schemaType: string | undefined, format: string | undefined): FormInputType {
  if (schemaType === 'boolean') return 'checkbox';
  if (schemaType === 'number' || schemaType === 'integer') return 'number';
  return (format && formatTypes[format]) || 'text';
}

/** Reads the form in a data part's data, or returns undefined when it isn't one. */
export function readForm(data: unknown): FormView | undefined {
  const obj = asObject(data);
  const schema = asObject(obj.form);
  if (obj.type !== 'form' || schema.properties === undefined) return undefined;
  const required = new Set(asStrings(schema.required));
  const formData = asObject(obj.form_data);
  const fields: FormField[] = [];
  const initial: FormInputs = {};
  for (const [name, raw] of Object.entries(asObject(schema.properties))) {
    const prop = asObject(raw);
    const schemaType = asString(prop.type);
    const field: FormField = {
      name,
      label: asString(prop.title) || name,
      inputType: inputType(schemaType, asString(prop.format)),
      schemaType,
      required: required.has(name),
      description: asString(prop.description),
    };
    fields.push(field);
    const value = formData[name];
    if (field.inputType === 'checkbox') {
      initial[name] = value === true;
    } else {
      initial[name] = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    }
  }
  return { instructions: asString(obj.instructions), fields, initial };
}

/**
 * The values to send back, typed by the schema: numbers for number and integer properties (left
 * out when empty), booleans for checkboxes and strings for the rest.
 */
export function formValues(form: FormView, inputs: FormInputs): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of form.fields) {
    const input = inputs[field.name] ?? form.initial[field.name];
    if (field.inputType === 'checkbox') {
      values[field.name] = input === true;
    } else if (field.schemaType === 'number' || field.schemaType === 'integer') {
      const n = Number(input);
      if (String(input).trim() !== '' && Number.isFinite(n)) values[field.name] = n;
    } else {
      values[field.name] = typeof input === 'string' ? input : '';
    }
  }
  return values;
}

/** The inputs that show submitted values again. */
export function formInputs(form: FormView, values: Record<string, unknown>): FormInputs {
  const inputs: FormInputs = {};
  for (const field of form.fields) {
    const v = values[field.name];
    inputs[field.name] = field.inputType === 'checkbox' ? v === true : v === undefined || v === null ? '' : String(v);
  }
  return inputs;
}
