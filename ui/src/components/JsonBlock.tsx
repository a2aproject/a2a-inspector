/** Pretty-prints JSON, given as a value or as text; other text is shown as it is. */
export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  let text: string;
  if (typeof value === 'string') {
    try {
      text = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      text = value;
    }
  } else {
    text = JSON.stringify(value, null, 2) ?? '';
  }
  return (
    <pre className="json" aria-label={label} tabIndex={0}>
      {text}
    </pre>
  );
}
