// Flow's mark: the overlay's voice waveform as seven rounded bars.
const BARS = [0.34, 0.6, 0.86, 1, 0.86, 0.6, 0.34];

const FlowGlyph = ({
  width,
  height,
  className,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
}) => (
  <svg
    width={width || 24}
    height={height || 24}
    viewBox="0 0 24 24"
    className={`fill-text ${className ?? ""}`}
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    {BARS.map((h, i) => {
      const barH = 4 + h * 14;
      return (
        <rect
          key={i}
          x={3.25 + i * 2.75}
          y={12 - barH / 2}
          width={1.75}
          height={barH}
          rx={0.875}
        />
      );
    })}
  </svg>
);

export default FlowGlyph;
