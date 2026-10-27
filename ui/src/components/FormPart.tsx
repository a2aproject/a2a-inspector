import { Fragment, type SubmitEvent, useId, useState } from 'react';
import { type FormInputs, type FormView, formInputs, formValues } from '../a2a/form';

interface Props {
  form: FormView;
  /** The values sent, once the form was submitted. */
  submitted?: Record<string, unknown>;
  /** Missing where the form can't be answered; it's shown read-only then. */
  onSubmit?: (values: Record<string, unknown>) => void;
  disabled?: boolean;
}

/** A form an agent sent in a data part, answered with a data part of its values. */
export function FormPart({ form, submitted, onSubmit, disabled }: Props) {
  const id = useId();
  const [inputs, setInputs] = useState<FormInputs>(form.initial);
  const readOnly = submitted !== undefined || !onSubmit;
  const shown = submitted ? formInputs(form, submitted) : inputs;

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!readOnly && !disabled) onSubmit?.(formValues(form, inputs));
  }

  return (
    <form className="form-part" aria-label="Form from the agent" onSubmit={submit}>
      {form.instructions && <p className="text">{form.instructions}</p>}
      <div className="fields">
        {form.fields.map((f) => {
          const inputId = `${id}-${f.name}`;
          const value = shown[f.name];
          return (
            <Fragment key={f.name}>
              <label htmlFor={inputId}>
                {f.label}
                {f.required && <span aria-hidden="true"> *</span>}
              </label>
              <div>
                {f.inputType === 'checkbox' ? (
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={value === true}
                    disabled={readOnly}
                    aria-describedby={f.description ? `${inputId}-help` : undefined}
                    onChange={(e) => setInputs((prev) => ({ ...prev, [f.name]: e.target.checked }))}
                  />
                ) : (
                  <input
                    id={inputId}
                    type={f.inputType}
                    value={typeof value === 'string' ? value : ''}
                    required={f.required}
                    readOnly={readOnly}
                    aria-describedby={f.description ? `${inputId}-help` : undefined}
                    onChange={(e) => setInputs((prev) => ({ ...prev, [f.name]: e.target.value }))}
                  />
                )}
                {f.description && (
                  <p id={`${inputId}-help`} className="help">
                    {f.description}
                  </p>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
      {submitted ? (
        <p className="faint small">Submitted.</p>
      ) : onSubmit ? (
        <button type="submit" className="button" disabled={disabled}>
          Submit
        </button>
      ) : (
        <p className="faint small">Answer it in the Chat tab.</p>
      )}
    </form>
  );
}
