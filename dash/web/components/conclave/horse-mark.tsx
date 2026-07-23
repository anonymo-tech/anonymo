import "./horse-mark.css";

/** The Conclave horse mark, tinted by its surrounding brand treatment. */
export function HorseMark({ className = "" }: { className?: string }) {
  return <span className={`horse-mark ${className}`} aria-hidden="true" />;
}
