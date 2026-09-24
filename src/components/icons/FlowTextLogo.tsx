import FlowGlyph from "./FlowGlyph";

// The product name is a brand mark, not translatable copy.
const PRODUCT_NAME = "Flow";

// Wordmark: waveform glyph + "Flow", sized by width like the old SVG logo.
const FlowTextLogo = ({
  width = 120,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) => {
  const size = width / 3.4;
  return (
    <div
      className={`flex items-center justify-center text-text select-none ${className ?? ""}`}
      style={{ width, gap: size * 0.18 }}
    >
      <FlowGlyph width={size} height={size} />
      <span
        className="font-semibold tracking-tight leading-none"
        style={{ fontSize: size * 0.82 }}
      >
        {PRODUCT_NAME}
      </span>
    </div>
  );
};

export default FlowTextLogo;
