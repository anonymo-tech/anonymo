export function Wordmark({
  uppercase = false,
  className = "",
}: {
  uppercase?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`conclave-wordmark${uppercase ? " conclave-wordmark--uppercase" : ""}${className ? ` ${className}` : ""}`}
    >
      <span className="conclave-wordmark-label">Conclave</span>
    </span>
  );
}
